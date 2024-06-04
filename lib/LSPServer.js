const assert = require('assert');
const BigNumber = require('bignumber.js');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs').promises;
const debug = require('./debug');
const grpc = require('@grpc/grpc-js');
const http = require('http');
const JsonRpcError = require('./JsonRpcError');
const path = require('path');
const protoLoader = require('@grpc/proto-loader');
const stream = require('stream');
const uuid = require('uuid');

// https://docs.lightning.engineering/lightning-network-tools/lnd/grpc-api
// https://lightning.engineering/api-docs/api/lnd/

let LSPServer = function(options) {
	this.options = this.prepareOptions(options);
	this.app = this.createWebServer();
	// !! NOTE !!
	// Orders are stored in memory. This is not intended for production use.
	this.orders = new Map;
	this.orderHoldInvoiceInfo = new Map;
};

LSPServer.prototype.defaultOptions = {
	host: 'localhost',
	port: 3000,
	lightning: {
		host: 'localhost',
		port: 10009,
		macaroon: null,
		cert: null,
		tlsHostNameOverride: null,
		// https://github.com/lightningnetwork/lnd/blob/v0.17.0-beta/lnrpc
		protoFilePath: path.join(__dirname, 'proto', 'lnd', '0.17.0-beta', 'lnrpc', 'index.proto'),
	},
	lsp: {
		min_required_channel_confirmations: 0,
		min_funding_confirms_within_blocks: 6,
		min_onchain_payment_confirmations: 1,
		supports_zero_channel_reserve: true,
		min_onchain_payment_size_sat: null,
		max_channel_expiry_blocks: 20160,
		min_initial_client_balance_sat: '20000',
		max_initial_client_balance_sat: '100000000',
		min_initial_lsp_balance_sat: '0',
		max_initial_lsp_balance_sat: '100000000',
		min_channel_balance_sat: '50000',
		max_channel_balance_sat: '100000000',
	},
};

LSPServer.prototype.init = function() {
	return this.prepareLnRpc().then(() => {
		return this.listen();
	});
};

LSPServer.prototype.prepareOptions = function(options) {
	options = Object.assign({}, this.defaultOptions, options || {});
	options.lightning = Object.assign({}, this.defaultOptions.lightning, options.lightning || {});
	options.lsp = Object.assign({}, this.defaultOptions.lsp || {}, options.lsp || {});
	this.checkLSPOptions(options.lsp);
	return options;
};

LSPServer.prototype.setLSPOption = function(key, value) {
	let lspOptions = {};
	lspOptions[key] = value;
	return this.setLSPOptions(lspOptions)
};

LSPServer.prototype.setLSPOptions = function(lspOptions) {
	const newLspOptions = Object.assign({}, this.options.lsp || {}, lspOptions || {});
	this.checkLSPOptions(newLspOptions);
	this.options.lsp = newLspOptions;
};

LSPServer.prototype.checkLSPOptions = function(lspOptions) {
	Object.keys(lspOptions).forEach(key => {
		assert.notStrictEqual(typeof this.defaultOptions.lsp[key], 'undefined', `Unknown LSP option: ${key}`);
		if (key.substr(0, 'min_'.length) === 'min_') {
			const maxKey = 'max_' + key.substr('min_'.length);
			if (typeof lspOptions[maxKey] !== 'undefined') {
				const minValue = lspOptions[key];
				const maxValue = lspOptions[maxKey];
				assert.ok((new BigNumber(minValue)).isLessThanOrEqualTo(maxValue), `${key} must be <= ${maxKey}`);
			}
		}
	});
};

LSPServer.prototype.prepareLnRpc = function() {
	return Promise.resolve().then(() => {
		const { protoFilePath } = this.options.lightning;
		return this.loadLnRpcService(protoFilePath).then(lnrpc => {
			this.lnrpc = lnrpc;
		});
	});
};

LSPServer.prototype.loadLnRpcService = function(protoFilePath) {
	return Promise.resolve().then(() => {
		assert.ok(protoFilePath, 'Missing required argument: "protoFilePath"');
		assert.strictEqual(typeof protoFilePath, 'string', 'Invalid argument ("protoFilePath"): String expected');
		return protoLoader.load(protoFilePath, {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
		}).then(packageDefinition => {
			const {
				lnrpc,
				invoicesrpc
			} = grpc.loadPackageDefinition(packageDefinition);
			return Promise.all([
				fs.readFile(this.options.lightning.macaroon),
				fs.readFile(this.options.lightning.cert),
			]).then(files => {
				let [ macaroon, cert ] = files;
				const macaroonCreds = grpc.credentials.createFromMetadataGenerator((args, callback) => {
					let metadata = new grpc.Metadata();
					metadata.add('macaroon', macaroon.toString('hex'));
					callback(null, metadata);
				});
				const { host, port, tlsHostNameOverride } = this.options.lightning;
				const sslCreds = grpc.credentials.createSsl(cert);
				const credentials = grpc.credentials.combineChannelCredentials(sslCreds, macaroonCreds);
				debug.log(`Connecting to Lightning Node via gRPC at ${host}:${port}...`);
				const channelOptions = {};
				if (tlsHostNameOverride) {
					// A bit hacky...
					// The tls.cert of lnd doesn't include the host/IP address of the pod given to us by scaling-lightning.
					channelOptions['grpc.ssl_target_name_override'] = tlsHostNameOverride;
				}
				return {
					Invoices: new invoicesrpc.Invoices(`${host}:${port}`, credentials, channelOptions),
					Lightning: new lnrpc.Lightning(`${host}:${port}`, credentials, channelOptions)
				};
			});
		});
	});
};

LSPServer.prototype.lnrpcRequest = function(service, method, request) {
	return Promise.resolve().then(() => {
		const args = Array.prototype.slice.call(arguments);
		// Overloaded function signature.
		// Can be called as lnrpcRequest(method, request) or lnrpcRequest(method):
		if (args.length < 3) {
			request = method;
			method = service;
			service = 'Lightning';
		}
		request = request || {};
		assert.ok(this.lnrpc, 'LN gRPC client not initialized');
		assert.strictEqual(typeof service, 'string', 'Invalid argument ("method"): String expected');
		assert.strictEqual(typeof method, 'string', 'Invalid argument ("method"): String expected');
		assert.strictEqual(typeof request, 'object', 'Invalid argument ("request"): Object expected');
		assert.ok(this.lnrpc[service], `LN gRPC service does not exist: ${service}`);
		assert.strictEqual(typeof this.lnrpc[service][method], 'function', `LN gRPC service method does not exist: ${service} ${method}`);
		return new Promise((resolve, reject) => {
			try {
				this.lnrpc[service][method](request, (error, response) => {
					if (error) return reject(error);
					resolve(response);
				});
			} catch (error) {
				reject(error);
			}
		});
	});
};

LSPServer.prototype.listen = function() {
	return Promise.resolve().then(() => {
		const { host, port } = this.options;
		this.app.server = this.app.listen(port, host);
		return new Promise((resolve, reject) => {
			try {
				const interval = setInterval(() => {
					if (this.app && this.app.server && this.app.server.listening) {
						debug.log('JSON-RPC HTTP server is ready and listening for incoming requests...');
						clearInterval(interval);
						resolve();
					}
				}, 10);
			} catch (error) {
				reject(error);
			}
		});
	});
};

LSPServer.prototype.createWebServer = function() {
	let app = express();
	app.disable('x-powered-by');// Don't send "X-Powered-By" header.
	app.use(bodyParser.json());// Parse JSON requests.
	app.use((req, res, next) => {
		this.requestHandler(req, res).then(result => {
			const { id } = req.body || {};
			res.status(200).json({
				id,
				jsonrpc: '2.0',
				result,
			});
		}).catch(next);
	});
	app.use((error, req, res, next) => {
		if (!(error instanceof JsonRpcError)) {
			debug.error(error);
			error = new JsonRpcError('internal_error');
		}
		const { id } = req.body || {};
		const { code, message, httpStatusCode, data } = error;
		res.status(error.httpStatusCode).json({
			id,
			jsonrpc: '2.0',
			error: { code, message, data },
		});
	});
	return app;
};

LSPServer.prototype.requestHandler = function(req) {
	return Promise.resolve().then(() => {
		const { id, jsonrpc, method } = req.body || {};
		const params = req.body.params || {};
		assert.ok(id, new JsonRpcError('invalid_request'));
		assert.ok(method && typeof method === 'string', new JsonRpcError('invalid_request'));
		assert.strictEqual(jsonrpc, '2.0', new JsonRpcError('invalid_request'));
		assert.ok(typeof params === 'object', new JsonRpcError('invalid_request'));
		assert.notStrictEqual(typeof this.jsonRpcMethods[method], 'undefined', new JsonRpcError('method_not_found'));
		const { handler, knownParams } = this.jsonRpcMethods[method] || {};
		const unrecognized = Object.keys(params).filter(key => {
			return !knownParams || !knownParams.includes(key);
		});
		assert.strictEqual(unrecognized.length, 0, new JsonRpcError('invalid_params', { unrecognized }));
		return handler.call(this, params);
	});
};

LSPServer.prototype.jsonRpcMethods = {
	'lsps0.list_protocols': {
		knownParams: [],
		handler: function() {
			return [ 1 ];
		},
	},
	'lsps1.get_info': {
		knownParams: [],
		handler: function() {
			return {
				options: this.options.lsp,
			};
		},
	},
	'lsps1.create_order': {
		knownParams: [
			'lsp_balance_sat',
			'client_balance_sat',
			'client_node_pubkey',// !! NOTE !! Non-standard parameter.
			'required_channel_confirmations',
			'funding_confirms_within_blocks',
			'channel_expiry_blocks',
			'token',
			'refund_onchain_address',
			'announce_channel',
		],
		handler: function(params) {
			// !! TODO !! Validate all params.
			assert.ok(params.client_node_pubkey, new JsonRpcError('invalid_params', { message: 'Missing required parameter: "client_node_pubkey"' }));
			return this.lnrpcRequest('ListPeers').then(response => {
				return response.peers;
			}).then(peers => {
				const clientNodeIsConnectedPeer = peers.filter(peer => {
					return peer.pub_key === params.client_node_pubkey;
				}).length > 0;
				assert.ok(clientNodeIsConnectedPeer, new JsonRpcError('client_rejected', { message: 'Node specified by "client_node_pubkey" is not a connected peer' }));
				const amount = new BigNumber(params.client_balance_sat);
				const flatFeeSat = '5000';
				const feePercent = '0.1';
				const feeSat = amount.times(feePercent).dividedBy('100').plus(flatFeeSat).toString();
				const orderTotalSat = amount.plus(feeSat).toString();
				const now = Date.now();
				const orderId = uuid.v4();
				const r_preimage = crypto.randomBytes(20);// raw bytes
				const r_hash = crypto.createHash('sha256').update(r_preimage).digest();// raw bytes
				return this.lnrpcRequest('Invoices', 'AddHoldInvoice', {
					memo: `lsp-order-${orderId}`,
					hash: r_hash,
					value: orderTotalSat,
					expiry: 3600,
					private: !params.announce_channel,
				}).then(response => {
					assert.ok(response && response.payment_request);
					return response.payment_request;
				}).then(paymentInvoice => {
					return this.lnrpcRequest('NewAddress', { type: 0 }).then(response => {
						assert.ok(response && response.address);
						return response.address;
					}).then(paymentAddress => {
						const order = {
							order_id: orderId,
							lsp_balance_sat: params.lsp_balance_sat,
							client_balance_sat: params.client_balance_sat,
							client_node_pubkey: params.client_node_pubkey,
							required_channel_confirmations: params.required_channel_confirmations,
							funding_confirms_within_blocks: params.funding_confirms_within_blocks,
							channel_expiry_blocks: params.channel_expiry_blocks,
							token: params.token,
							created_at: (new Date(now)).toISOString(),
							expires_at: (new Date(now + 86400000)).toISOString(),
							announce_channel: params.announce_channel,
							order_state: 'CREATED',
							payment: {
								state: 'EXPECT_PAYMENT',
								fee_total_sat: feeSat,
								order_total_sat: orderTotalSat,
								bolt11_invoice: paymentInvoice,
								onchain_address: paymentAddress,
								min_onchain_payment_confirmations: this.options.lsp.min_onchain_payment_confirmations,
								min_fee_for_0conf: 253,// hard-coded value in the LSP spec?
								onchain_payment: null,
							},
							channel: null,
						};
						return this.saveOrder(order, { r_hash, r_preimage });
					});
				});
			});
		},
	},
	'lsps1.get_order': {
		knownParams: [
			'order_id',
		],
		handler: function(params) {
			return this.getOrder(params.order_id).then(order => {
				assert.ok(order, new JsonRpcError('order_not_found'));
				return this.checkOrderPaymentStatus(order).then(order => {
					if (
						!order.channel &&
						(
							order.payment.state === 'HOLD' ||
							order.payment.state === 'PAID'
						)
					) {
						return this.openChannelForOrder(order).then(channel => {
							order.channel = channel;
							if (order.payment.state === 'HOLD') {
								const { r_preimage } = this.getOrderHoldInvoiceInfo(order.order_id);
								return this.lnrpcRequest('SettleInvoice', { preimage: r_preimage }).then(() => {
									order.payment.state = 'PAID';
								});
							}
						}).then(() => {
							return this.saveOrder(order);
						});
					}
				}).then(() => {
					return this.getOrder(order.order_id);
				});
			});
		},
	},
};

LSPServer.prototype.checkOrderPaymentStatus = function(order) {
	return Promise.resolve().then(() => {
		if (order.payment.state === 'EXPECT_PAYMENT') {
			return this.getOrderHoldInvoiceInfo(order.order_id).then(holdInvoiceInfo => {
				const { r_hash } = holdInvoiceInfo;
				return this.lnrpcRequest('LookupInvoice', { r_hash }).then(response => {
					if (response && response.state === 'ACCEPTED') {
						order.payment.state = 'HOLD';
						return this.saveOrder(order);
					}
					return order;
				}).then(order => {
					if (order.payment.state === 'EXPECT_PAYMENT' && !order.payment.onchain_payment) {
						// Find UTXO for the order's onchain address.
						return this.getTransactionsByAddress(order.payment.onchain_address).then(txs => {
							const tx = txs && txs[0] || null;
							if (tx) {
								const utxo = tx.output_details.find(out => {
									return out.is_our_address;
								});
								if (utxo) {
									const confirmed = (
										tx.num_confirmations >= order.payment.min_onchain_payment_confirmations &&
										(new BigNumber(tx.amount)).isGreaterThanOrEqualTo(order.payment.order_total_sat)
									);
									order.payment.onchain_payment = {
										outpoint: [ tx.tx_hash, utxo.output_index ].join(':'),
										sat: tx.amount,
										confirmed,
									};
									if (confirmed) {
										order.payment.state = 'PAID';
									}
									return this.saveOrder(order);
								}
							}
							return order;
						});
					}
					return order;
				}).then(order => {
					if (
						order.payment.state === 'EXPECT_PAYMENT' &&
						order.payment.onchain_payment &&
						order.payment.onchain_payment.outpoint
					) {
						// Check the confirmation status of the UTXO.
						const [ txid, ] = order.payment.onchain_payment.outpoint.split(':');
						return this.getTransaction(txid).then(tx => {
							assert.ok(tx);
							if (
								tx.num_confirmations >= order.payment.min_onchain_payment_confirmations &&
								(new BigNumber(tx.amount)).isGreaterThanOrEqualTo(order.payment.order_total_sat)
							) {
								order.payment.state = 'PAID';
								order.payment.onchain_payment.confirmed = true;
								return this.saveOrder(order);
							}
						});
					}
				});
			});
		}
	}).then(() => {
		return this.getOrder(order.order_id);
	});
};

LSPServer.prototype.getTransaction = function(txid) {
	return Promise.resolve().then(() => {
		assert.ok(txid, 'Missing required argument: "txid"');
		return this.lnrpcRequest('GetTransactions').then(response => {
			assert.ok(response && response.transactions);
			return response.transactions.find(tx => {
				return tx.tx_hash === txid;
			});
		});
	});
};

LSPServer.prototype.getTransactionsByAddress = function(address) {
	return Promise.resolve().then(() => {
		assert.ok(address, 'Missing required argument: "address"');
		return this.lnrpcRequest('GetTransactions').then(response => {
			assert.ok(response && response.transactions);
			return response.transactions.filter(tx => {
				return tx.dest_addresses.includes(address);
			});
		});
	});
};

LSPServer.prototype.openChannelForOrder = function(order) {
	return Promise.resolve().then(() => {
		return this.lnrpcRequest('OpenChannelSync', {
			sat_per_vbyte: 1,
			node_pubkey: Buffer.from(order.client_node_pubkey, 'hex'),
			local_funding_amount: (new BigNumber(order.lsp_balance_sat).plus(order.client_balance_sat)).toString(),
			push_sat: order.client_balance_sat,
			private: !order.announce_channel,
		}).then(response => {
			assert.ok(response);
			const now = Date.now();
			return {
				funded_at: (new Date(now)).toISOString(),
				funding_outpoint: [
					response.funding_txid_bytes.toString('hex'),
					response.output_index,
				].join(':'),
				expires_at: (new Date(now + (600000 * order.channel_expiry_blocks))).toISOString(),
			};
		});
	}).catch(error => {
		// !! TODO !! Handle openChannel failure case as described in LSPS1.
		// Re-throw.
		throw error;
	});
};

LSPServer.prototype.saveOrder = function(order, holdInvoiceInfo) {
	return Promise.resolve().then(() => {
		this.orders.set(order.order_id, order);
	}).then(() => {
		if (holdInvoiceInfo) {
			return this.saveOrderHoldInvoiceInfo(order.order_id, holdInvoiceInfo);
		}
	}).then(() => {
		return order;
	});
};

LSPServer.prototype.getOrder = function(id) {
	return Promise.resolve().then(() => {
		return this.orders.has(id) ? this.orders.get(id) : null;
	});
};

LSPServer.prototype.saveOrderHoldInvoiceInfo = function(id, holdInvoiceInfo) {
	return Promise.resolve().then(() => {
		this.orderHoldInvoiceInfo.set(id, holdInvoiceInfo);
	});
};

LSPServer.prototype.getOrderHoldInvoiceInfo = function(id) {
	return Promise.resolve().then(() => {
		return this.orderHoldInvoiceInfo.has(id) ? this.orderHoldInvoiceInfo.get(id) : null;
	});
};

LSPServer.prototype.close = function() {
	return this.closeWebServer();
};

LSPServer.prototype.closeWebServer = function() {
	return Promise.resolve().then(() => {
		if (this.app && this.app.server) {
			return new Promise((resolve, reject) => {
				try {
					this.app.server.close(() => {
						resolve();
					});
					this.app.server.closeAllConnections();
					this.app.server = null;
				} catch (error) {
					reject(error);
				}
			});
		}
	});
};

module.exports = LSPServer;
