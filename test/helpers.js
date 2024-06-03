const assert = require('assert');
const fs = require('fs').promises;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
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
		create: function(namespace) {
			return Promise.resolve().then(() => {
				assert.ok(namespace, 'Missing required argument: "namespace"');
				assert.strictEqual(typeof namespace, 'string', 'Invalid argument ("namespace"): String expected');
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
				]);
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
	promiseAllSeries: function(promiseFactories) {
		let result = Promise.resolve();
		promiseFactories.forEach(promiseFactory => {
			result = result.then(promiseFactory);
		});
		return result;
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
};
