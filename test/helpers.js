const assert = require('assert');
const BigNumber = require('bignumber.js');
const crypto = require('crypto');
const fs = require('fs').promises;
const http = require('http');
const LSPServer = require('../');
const path = require('path');
const { spawn } = require('child_process');
const secp256k1 = require('secp256k1');
const url = require('url');

const debug = {
	log: require('debug')('workshop:test:log'),
};
const fixturesDir = path.join(__dirname, 'fixtures');
const tmpDir = path.join(__dirname, 'tmp');

const helpers = module.exports = {
	debug,
	fixturesDir,
	tmpDir,
	jsonRpcRequestIdIncrement: 1,
	prepareTmpDir: function() {
		return this.removeTmpDir().then(() => {
			return this.createTmpDir();
		});
	},
	createTmpDir: function() {
		return this.mkdirp(tmpDir);
	},
	removeTmpDir: function() {
		return this.removeDir(tmpDir);
	},
	mkdirp: function(dirPath) {
		return Promise.resolve().then(() => {
			assert.ok(dirPath, 'Missing required argument: "dirPath"');
			assert.strictEqual(typeof dirPath, 'string', 'Invalid argument ("dirPath"): String expected');
			return fs.stat(dirPath).then(() => {
				// Directory exists. Do nothing.
			}).catch(error => {
				if (/no such file or directory/i.test(error.message)) {
					// Directory doesn't exist.
					return fs.mkdir(dirPath, { recursive: true });
				}
				// Re-throw any other error.
				throw error;
			});
		});
	},
	removeDir: function(dirPath) {
		return Promise.resolve().then(() => {
			assert.ok(dirPath, 'Missing required argument: "dirPath"');
			assert.strictEqual(typeof dirPath, 'string', 'Invalid argument ("dirPath"): String expected');
			return fs.stat(dirPath).then(() => {
				// Directory exists.
				// List files and delete each one.
				return fs.readdir(dirPath).then(files => {
					return Promise.all(files.map(file => {
						const filePath = path.join(dirPath, file);
						return fs.stat(filePath).then(stat => {
							if (stat.isDirectory()) {
								return this.removeDir(filePath);
							}
							return fs.unlink(filePath);
						});
					})).then(() => {
						// Finally delete the directory itself.
						return fs.rmdir(dirPath);
					});
				});
			}).catch(error => {
				if (!/no such file or directory/i.test(error.message)) {
					// Directory doesn't exist error is ok.
					// Re-throw any other error.
					throw error;
				}
			});
		});
	},
	scalingLightning: {
		networks: {},
		create: function(namespace) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				this.networks[namespace] = { nodes: {} };
				const helmFilePath = path.join(fixturesDir, 'helmfiles', `${namespace}.yaml`);
				return fs.stat(helmFilePath).then(() => {
					debug.log(`Creating network ("${namespace}")...`);
					return this.cli([
						'create',
						'--helmfile', helmFilePath
					]).then(stdout => {
						assert.match(stdout, /Network started/i, stdout);
						// Create tmp dir for namespace.
						const dir = path.join(tmpDir, namespace);
						return helpers.mkdirp(dir);
					});
				});
			});
		},
		destroy: function(namespace) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				this.networks[namespace] = null;
				const helmFilePath = path.join(fixturesDir, 'helmfiles', `${namespace}.yaml`);
				return fs.stat(helmFilePath).then(() => {
					debug.log(`Destroying network ("${namespace}")...`);
					return this.cli([
						'destroy',
						'--namespace', namespace,
					]);
				}).then(stdout => {
					assert.match(stdout, /Destroying the network/i, stdout);
				});
			});
		},
		list: function(namespace) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				return this.cli([
					'list',
					'--namespace', namespace
				]).then(stdout => {
					const regex = new RegExp('^(Bitcoin nodes:\n(\n[\t ]+[a-zA-Z0-9\-_]+)+)\n\n(Lightning nodes:\n(\n[\t ]+[a-zA-Z0-9\-_]+)+)', 'i');
					const match = stdout.match(regex);
					assert.ok(match, stdout);
					const nodes = {};
					match[1].split('\n').splice(2).forEach(bitcoinNode => {
						const name = bitcoinNode.trim();
						nodes[name] = { type: 'bitcoin', name };
					});
					match[match.length - 2].split('\n').splice(2).forEach(lightningNode => {
						const name = lightningNode.trim();
						nodes[name] = { type: 'lightning', name };
					});
					return nodes;
				});
			});
		},
		prepareConnectionInfo: function(namespace, name) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(name, 'Missing required argument: "name"');
				assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
				return Promise.all([
					this.connectionDetails(namespace, name),
					this.writeAuthFiles(namespace, name),
				]).then(results => {
					const [ connectionDetails, authFiles ] = results;
					const { host, port } = connectionDetails;
					const { macaroon, cert } = authFiles;
					const connection = {
						host,
						port,
						macaroon,
						cert,
						tlsHostNameOverride: name,
					};
					this.networks[namespace] = this.networks[namespace] || { nodes: {} };
					this.networks[namespace].nodes[name] = this.networks[namespace].nodes[name] || {};
					this.networks[namespace].nodes[name].connection = connection;
					return connection;
				});
			});
		},
		connectionDetails: function(namespace, name) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(name, 'Missing required argument: "name"');
				assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
				return this.cli([
					'connectiondetails',
					'--namespace', namespace,
					'--node', name,
				]).then(stdout => {
					const regex = new RegExp(`^${name}\n +type: +[a-z]+\n +host: +([a-zA-Z0-9\-\.]+)\n +port: +([0-9]+)`, 'i');
					const match = stdout.match(regex);
					assert.ok(match, stdout);
					let [, host, port ] = match;
					port = parseInt(port);
					return { host, port };
				});
			});
		},
		writeAuthFiles: function(namespace, name, ) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(name, 'Missing required argument: "name"');
				assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
				const dir = path.join(tmpDir, namespace, name);
				return helpers.mkdirp(dir).then(() => {
					return this.cli([
						'writeauthfiles',
						'--namespace', namespace,
						'--node', name,
						'--dir', dir,
					]).then(() => {
						return {
							// lnd is assumed.
							macaroon: path.join(dir, 'admin.macaroon'),
							cert: path.join(dir, 'tls.cert'),
						};
					});
				});
			});
		},
		pubKey: function(namespace, name) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(name, 'Missing required argument: "name"');
				assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
				return this.cli([
					'pubkey',
					'--namespace', namespace,
					'--node', name,
				]).then(pubKey => {
					pubKey = pubKey.trim();
					this.networks[namespace] = this.networks[namespace] || { nodes: {} };
					this.networks[namespace].nodes[name] = this.networks[namespace].nodes[name] || {};
					this.networks[namespace].nodes[name].pubKey = pubKey;
					return pubKey;
				});
			});
		},
		send: function(namespace, from, to, amountSats) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(from, 'Missing required argument: "from"');
				assert.strictEqual(typeof from, 'string', 'Invalid argument ("from"): String expected');
				assert.ok(to, 'Missing required argument: "to"');
				assert.strictEqual(typeof to, 'string', 'Invalid argument ("to"): String expected');
				assert.ok(amountSats, 'Missing required argument: "amountSats"');
				assert.ok(helpers.isValidBigNumberInteger(amountSats), 'Invalid argument ("amountSats"): Integer expected');
				return this.cli([
					'send',
					'--namespace', namespace,
					'--from', from,
					'--to', to,
					'--amount', amountSats,
				]).then(stdout => {
					assert.match(stdout, /^Sent funds, txid: /i);
				});
			});
		},
		connectPeer: function(namespace, from, to) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(from, 'Missing required argument: "from"');
				assert.strictEqual(typeof from, 'string', 'Invalid argument ("from"): String expected');
				assert.ok(to, 'Missing required argument: "to"');
				assert.strictEqual(typeof to, 'string', 'Invalid argument ("to"): String expected');
				return this.cli([
					'connectpeer',
					'--namespace', namespace,
					'--from', from,
					'--to', to,
				]);
			});
		},
		generate: function(namespace, name, numBlocks) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
				assert.ok(name, 'Missing required argument: "name"');
				assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
				assert.ok(Number.isInteger(numBlocks), 'Invalid argument ("numBlocks"): Integer expected');
				assert.ok(numBlocks > 0, 'Invalid argument ("numBlocks"): Must be greater than 0');
				return this.cli([
					'generate',
					'--namespace', namespace,
					'--node', name,
					'--blocks', numBlocks,
				]).then(stdout => {
					assert.match(stdout, /^Generated blocks:/i);
				});
			});
		},
		cli: function(args, options) {
			return Promise.resolve().then(() => {
				assert.ok(args instanceof Array, 'Invalid argument ("args"): Array expected');
				options = Object.assign({}, {
					stdin: null,
				}, options || {});
				assert.ok(!options.stdin || typeof options.stdin === 'string', 'Invalid option ("stdin"): String expected');
				debug.log('CLI:', 'scaling-lightning', args);
				const child = spawn('scaling-lightning', args);
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', data => {
					stdout += data.toString();
				});
				child.stderr.on('data', data => {
					stderr += data.toString();
				});
				if (options.stdin) {
					child.stdin.write(options.stdin);
				}
				child.stdin.end();
				return new Promise((resolve, reject) => {
					child.on('close', () => {
						if (/context deadline exceeded/i.test(stdout)) {
							stderr = stdout;
						}
						if (stderr) {
							debug.log('CLI:', 'stderr:', stderr);
							return reject(new Error(stderr));
						}
						debug.log('CLI:', 'stdout:', stdout);
						resolve(stdout);
					});
				});
			});
		},
	},
	lnrpcRequest: function(namespace, name, method, params) {
		return Promise.resolve().then(() => {
			const lightning = this.getNodeConnectionInfo(namespace, name);
			const client = new LSPServer({ lightning });
			return client.prepareLnRpc().then(() => {
				return client.lnrpcRequest(method, params);
			});
		});
	},
	getNode: function(namespace, name) {
		assert.ok(namespace, 'Missing required argument: "namespace"');
		assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
		assert.ok(name, 'Missing required argument: "name"');
		assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
		assert.ok(this.scalingLightning.networks[namespace]);
		assert.ok(this.scalingLightning.networks[namespace].nodes[name]);
		return this.scalingLightning.networks[namespace].nodes[name];
	},
	getNodePubKey: function(namespace, name) {
		return this.getNode(namespace, name).pubKey;
	},
	getNodeConnectionInfo: function(namespace, name) {
		return this.getNode(namespace, name).connection;
	},
	prepareOrder: function(namespace, name, params) {
		return Promise.resolve().then(() => {
			assert.ok(namespace, 'Missing required argument: "namespace"');
			assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
			assert.ok(name, 'Missing required argument: "name"');
			assert.strictEqual(typeof name, 'string', 'Invalid argument ("name"): String expected');
			assert.ok(!params || typeof params === 'object', 'Invalid argument ("params"): Object expected');
			return this.lnrpcRequest(namespace, name, 'NewAddress', { type: 0 }).then(refundOnchainAddress => {
				params = Object.assign({
					lsp_balance_sat: '1000000',
					client_balance_sat: '0',
					client_node_pubkey: this.scalingLightning.networks[namespace].nodes[name].pubKey,
					required_channel_confirmations: 0,
					funding_confirms_within_blocks: 6,
					channel_expiry_blocks: 144,
					token: '',
					refund_onchain_address: refundOnchainAddress,
					announce_channel: true,
				}, params || {});
				return this.jsonRpcRequest('lsps1.create_order', params).then(response => {
					assert.ok(response.result, JSON.stringify(response));
					const order = response.result;
					assert.ok(order && order.order_id);
					return order;
				});
			});
		});
	},
	wait: function(delay) {
		return new Promise(resolve => {
			setTimeout(resolve, delay);
		});
	},
	waitForBlockHeightToCatchUp: function(namespace, bitcoinNode, lightningNode) {
		return Promise.resolve().then(() => {
			assert.ok(namespace, 'Missing required argument: "namespace"');
			assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
			assert.ok(bitcoinNode, 'Missing required argument: "bitcoinNode"');
			assert.strictEqual(typeof bitcoinNode, 'string', 'Invalid argument ("bitcoinNode"): String expected');
			assert.ok(lightningNode, 'Missing required argument: "lightningNode"');
			assert.strictEqual(typeof lightningNode, 'string', 'Invalid argument ("lightningNode"): String expected');
		});
	},
	promiseAllSeries: function(promiseFactories) {
		let result = Promise.resolve();
		promiseFactories.forEach(promiseFactory => {
			result = result.then(promiseFactory);
		});
		return result;
	},
	isValidBigNumberInteger: function(value) {
		let bn;
		try { bn = new BigNumber(value); } catch (error) {
			return false;
		}
		return bn.isInteger();
	},
	jsonRpcRequest: function(method, params, options) {
		return new Promise((resolve, reject) => {
			try {
				assert.ok(method, 'Missing required argument: "method"');
				assert.strictEqual(typeof method, 'string', 'Invalid argument ("method"): String expected');
				assert.ok(!params || typeof params === 'object', 'Invalid argument ("params"): Object expected');
				params = params || {};
				options = Object.assign({
					host: 'localhost',
					port: 3000,
					headers: {},
				}, options || {});
				options.headers = Object.assign({
					'Content-Type': 'application/json',
				}, options.headers || {});
				const id = this.jsonRpcRequestIdIncrement++;
				const jsonrpc = '2.0';
				const postData = JSON.stringify({ id, jsonrpc, method, params });
				let requestOptions = url.parse(`http://${options.host}:${options.port}`);
				requestOptions.method = 'POST';
				requestOptions.headers = options.headers;
				requestOptions.headers['Content-Length'] = Buffer.byteLength(postData);
				const req = http.request(requestOptions, response => {
					let body = '';
					response.on('data', chunk => {
						body += chunk.toString();
					});
					response.on('end', () => {
						assert.ok(response.headers['content-type']);
						assert.strictEqual(response.headers['content-type'].substr(0, 'application/json'.length), 'application/json');
						let parsed;
						try { parsed = JSON.parse(body); } catch (error) {
							return reject(error);
						}
						assert.strictEqual(typeof parsed, 'object');
						assert.strictEqual(parsed.jsonrpc, '2.0');
						assert.strictEqual(parsed.id, id);
						resolve(parsed);
					});
				});
				req.write(postData);
				req.once('error', reject);
				req.end();
			} catch (error) {
				reject(error);
			}
		});
	},
	generateRandomLightningNodeKeyPair: function() {
		let privKey;
		do {
			privKey = crypto.randomBytes(32);
		} while (!secp256k1.privateKeyVerify(privKey))
		const pubKey = Buffer.from(secp256k1.publicKeyCreate(privKey));
		return { privKey, pubKey };
	},
};
