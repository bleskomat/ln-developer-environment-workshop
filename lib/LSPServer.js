const assert = require('assert');
const BigNumber = require('bignumber.js');
const bodyParser = require('body-parser');
const express = require('express');
const fs = require('fs').promises;
const debug = require('./debug');
const grpc = require('@grpc/grpc-js');
const http = require('http');
const JsonRpcError = require('./JsonRpcError');
const path = require('path');
const protoLoader = require('@grpc/proto-loader');

// https://docs.lightning.engineering/lightning-network-tools/lnd/grpc-api
// https://lightning.engineering/api-docs/api/lnd/

let LSPServer = function(options) {
	this.options = this.prepareOptions(options);
	this.app = this.createWebServer();
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
		protoFilePath: path.join(__dirname, 'proto', 'lnd', '0.17.0-beta', 'lnrpc', 'lightning.proto'),
	},
	lsp: {
		min_required_channel_confirmations: 0,
		min_funding_confirms_within_blocks: 6,
		min_onchain_payment_confirmations: null,
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

LSPServer.prototype.connect = function() {
	return Promise.resolve().then(() => {
		const { protoFilePath } = this.options.lightning;
		return protoLoader.load(protoFilePath, {
			keepCase: true,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
		}).then(packageDefinition => {
			const { lnrpc } = grpc.loadPackageDefinition(packageDefinition);
			return lnrpc;
		}).then(lnrpc => {
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
				this.lightning = new lnrpc.Lightning(`${host}:${port}`, credentials, channelOptions);
				return new Promise((resolve, reject) => {
					try {
						this.lightning.getInfo({}, (error, response) => {
							if (error) return reject(error);
							assert.ok(response.identity_pubkey);
							resolve(response);
						});
					} catch (error) {
						reject(error);
					}
				});
			});
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
					if (this.app.server.listening) {
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
		knownParams: [],
		handler: function(params) {
			console.log(params);
			throw new Error('Not implemented');
		},
	},
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
