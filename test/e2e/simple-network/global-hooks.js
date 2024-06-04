before(function() {
	const namespace = 'simple-network';
	this.network = { namespace };
	if (process.env.WORKSHOP_TEST_SKIP_NETWORK_SETUP) {
		this.helpers.debug.log('Skipping network setup and teardown...');
		return;
	}
	this.timeout(120000);
	return this.helpers.scalingLightning.create(namespace);
});

before(function() {
	const { namespace } = this.network;
	return this.helpers.scalingLightning.list(namespace).then(nodes => {
		this.network.nodes = nodes;
	});
});

before(function() {
	this.timeout(10000);
	// Prepare gRPC connection information.
	const { namespace } = this.network;
	return this.helpers.promiseAllSeries(
		Object.values(this.network.nodes).filter(node => node.type === 'lightning').map(node => {
			return function() {
				const { name } = node;
				return this.helpers.scalingLightning.prepareConnectionInfo(namespace, name);
			}.bind(this);
		})
	);
});

before(function() {
	// Wait for lightning nodes to be ready.
	const { namespace } = this.network;
	this.timeout(300000);
	return Promise.all(
		Object.values(this.network.nodes).filter(node => node.type === 'lightning').map(node => {
			const { name } = node;
			return this.helpers.scalingLightning.pubKey(namespace, name).then(pubKey => {
				this.network.nodes[name].pubKey = pubKey;
			});
		})
	);
});

after(function() {
	if (process.env.WORKSHOP_TEST_SKIP_NETWORK_SETUP) return;
	this.timeout(120000);
	const { namespace } = this.network;
	return this.helpers.scalingLightning.destroy(namespace);
});
