const assert = require('assert');
const LSPServer = require('../../../');

describe('lsps1', function() {

	let server;
	before(function() {
		server = new LSPServer({
			host: 'localhost',
			port: 3000,
		});
		return server.listen();
	});

	after(function() {
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
});
