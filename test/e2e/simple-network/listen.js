const assert = require('assert');
const LSPServer = require('../../../');

describe('listen()', function() {

	it('starts listening for connections as a JSON-RPC HTTP server', function() {
		const server = new LSPServer({
			host: 'localhost',
			port: 3000,
		});
		return server.listen().then(() => {
			return this.helpers.jsonRpcRequest('lsps0.list_protocols');
		}).then(() => {
			return server.close();
		});
	});

	describe('error cases', function() {

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

		it('method_not_found', function() {
			return this.helpers.jsonRpcRequest('unknown_method').then(response => {
				assert.ok(response.error);
				assert.strictEqual(response.error.message, 'Method not found');
				assert.strictEqual(response.error.code, -32601);
			});
		});
	});
});
