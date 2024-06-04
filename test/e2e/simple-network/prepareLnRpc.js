const assert = require('assert');
const LSPServer = require('../../../');

describe('prepareLnRpc', function() {

	it('can communicate with lnd via gRPC API', function() {
		const { namespace } = this.network;
		server = new LSPServer({
			host: 'localhost',
			port: 3000,
			lightning: this.helpers.getNodeConnectionInfo(namespace, 'alice'),
		});
		return server.prepareLnRpc().then(() => {
			return server.lnrpcRequest('GetInfo', {}).then(response => {
				assert.ok(response.identity_pubkey);
			});
		});
	});
});
