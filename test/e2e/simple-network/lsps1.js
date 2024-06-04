const assert = require('assert');
const BigNumber = require('bignumber.js');
const LSPServer = require('../../../');
const uuid = require('uuid');

describe('lsps1', function() {

	let server;
	let namespace;
	beforeEach(function() {
		namespace = this.network.namespace;
		server = new LSPServer({
			host: 'localhost',
			port: 3000,
			lightning: this.helpers.getNodeConnectionInfo(namespace, 'alice'),
		});
		return server.init();
	});

	afterEach(function() {
		if (server) return server.close();
	});

	describe('lsps1.get_info', function() {

		it('returns options supported by the LSP', function() {
			return this.helpers.jsonRpcRequest('lsps1.get_info').then(response => {
				assert.ok(!response.error);
				assert.strictEqual(typeof response.result, 'object');
				assert.strictEqual(typeof response.result.options, 'object');
			});
		});
	});

	describe('lsps1.create_order', function() {

		let refundOnchainAddress;
		beforeEach(function() {
			return this.helpers.lnrpcRequest(namespace, 'bob', 'NewAddress', { type: 0 }).then(address => {
				refundOnchainAddress = address;
			});
		});

		describe('client\'s node is connected to server\'s node', function() {

			beforeEach(function() {
				return this.helpers.scalingLightning.connectPeer(namespace, 'bob', 'alice');
			});

			it('returns order details', function() {
				const params = {
					lsp_balance_sat: '1000000',
					client_balance_sat: '0',
					client_node_pubkey: this.network.nodes['bob'].pubKey,
					required_channel_confirmations: 0,
					funding_confirms_within_blocks: 6,
					channel_expiry_blocks: 144,
					token: '',
					refund_onchain_address: refundOnchainAddress,
					announce_channel: true,
				};
				return this.helpers.jsonRpcRequest('lsps1.create_order', params).then(response => {
					assert.ok(response.result, JSON.stringify(response));
					assert.strictEqual(response.result.order_state, 'CREATED');
					assert.strictEqual(response.result.lsp_balance_sat, params.lsp_balance_sat);
					assert.strictEqual(response.result.client_balance_sat, params.client_balance_sat);
					assert.strictEqual(response.result.client_node_pubkey, params.client_node_pubkey);
					assert.strictEqual(response.result.required_channel_confirmations, params.required_channel_confirmations);
					assert.strictEqual(response.result.funding_confirms_within_blocks, params.funding_confirms_within_blocks);
					assert.strictEqual(response.result.channel_expiry_blocks, params.channel_expiry_blocks);
					assert.strictEqual(response.result.token, params.token);
					assert.strictEqual(response.result.announce_channel, params.announce_channel);
					assert.ok(response.result.order_id);
					assert.ok(response.result.payment);
					assert.strictEqual(response.result.payment.state, 'EXPECT_PAYMENT');
					assert.ok(response.result.payment.bolt11_invoice);
					assert.ok(response.result.payment.onchain_address);
					assert.strictEqual(response.result.payment.onchain_payment, null);
					assert.strictEqual(response.result.channel, null);
				});
			});
		});

		describe('not connected', function() {

			it('client rejected', function() {
				return this.helpers.jsonRpcRequest('lsps1.create_order', {
					lsp_balance_sat: '1000000',
					client_balance_sat: '0',
					client_node_pubkey: this.helpers.generateRandomLightningNodeKeyPair().pubKey,
					required_channel_confirmations: 0,
					funding_confirms_within_blocks: 6,
					channel_expiry_blocks: 144,
					token: '',
					refund_onchain_address: refundOnchainAddress,
					announce_channel: true,
				}).then(response => {
					assert.ok(response.error, JSON.stringify(response));
					assert.strictEqual(response.error.code, 1);
					assert.strictEqual(response.error.message, 'Client rejected');
				});
			});
		});
	});

	describe('lsps1.get_order', function() {

		beforeEach(function() {
			this.timeout(10000);
			return this.helpers.scalingLightning.connectPeer(namespace, 'bob', 'alice');
		});

		let order;
		beforeEach(function() {
			return this.helpers.prepareOrder(namespace, 'bob', {
				lsp_balance_sat: '500000',
				client_balance_sat: '500000',
			}).then(result => {
				order = result;
			});
		});

		it('not found', function() {
			return this.helpers.jsonRpcRequest('lsps1.get_order', {
				order_id: uuid.v4(),
			}).then(response => {
				assert.ok(response.error);
				assert.strictEqual(response.error.code, 101);
				assert.strictEqual(response.error.message, 'Order not found');
			});
		});

		it('returns order details of existing order', function() {
			return this.helpers.jsonRpcRequest('lsps1.get_order', {
				order_id: order.order_id,
			}).then(response => {
				assert.deepStrictEqual(response.result, order);
			});
		});

		describe('on-chain payment sent with minimum number of confirmations', function() {

			beforeEach(function() {
				const amountSat = (new BigNumber(order.payment.order_total_sat)).plus('10000').toString();
				return this.helpers.scalingLightning.send(namespace, 'bitcoind', 'bob', amountSat);
			});

			beforeEach(function() {
				return this.helpers.lnrpcRequest(namespace, 'bob', 'SendCoins', {
					amount: parseInt(order.payment.order_total_sat),
					addr: order.payment.onchain_address,
					sat_per_vbyte: 1,
				}).then(response => {
					assert.ok(response.txid);
				});
			});

			beforeEach(function() {
				return this.helpers.wait(500);
			});

			beforeEach(function() {
				return this.helpers.scalingLightning.generate(namespace, 'bitcoind', 3);
			});

			beforeEach(function() {
				return this.helpers.wait(500);
			});

			it('order state should be "PAID"', function() {
				this.timeout(120000);
				return this.helpers.jsonRpcRequest('lsps1.get_order', {
					order_id: order.order_id,
				}).then(response => {
					assert.ok(response.result, JSON.stringify(response));
					assert.strictEqual(response.result.order_id, order.order_id);
					assert.strictEqual(response.result.order_state, 'CREATED');
					assert.strictEqual(response.result.payment.state, 'PAID');
				});
			});
		});
	});
});
