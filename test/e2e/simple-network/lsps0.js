const assert = require('assert');
const LSPServer = require('../../../');

describe('lsps0', function() {

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

	describe('lsps0.list_protocols', function() {

		it('returns array of supported lsps protocols', function() {
			return this.helpers.jsonRpcRequest('lsps0.list_protocols').then(response => {
				assert.ok(!response.error);
				assert.deepStrictEqual(response.result, [ 1 ]);
			});
		});

		it('unrecognized params', function() {
			return this.helpers.jsonRpcRequest('lsps0.list_protocols', { unknown: 'x' }).then(response => {
				assert.ok(response.error);
				assert.deepStrictEqual(response.error.data, {
					unrecognized: [ 'unknown' ],
				});
			});
		});
	});
});
