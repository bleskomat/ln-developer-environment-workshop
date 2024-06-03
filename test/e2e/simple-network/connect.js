const assert = require('assert');
const LSPServer = require('../../../');

describe('connect()', function() {

	it('successfully connects to lnd via gRPC API', function() {
		assert.ok(this.network.nodes['alice']);
		const server = new LSPServer({
			lightning: this.network.nodes['alice'].connection,
		});
		return server.connect();
	});
});
