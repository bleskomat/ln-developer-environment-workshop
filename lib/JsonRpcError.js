const JsonRpcError = function(type, data) {
	if (!Error.captureStackTrace) {
		this.stack = (new Error()).stack;
	} else {
		Error.captureStackTrace(this, this.constructor);
	}
	if (!JsonRpcError.types[type]) {
		type = 'internal_error';
	}
	const { code, message, httpStatusCode } = JsonRpcError.types[type];
	this.type = type;
	this.code = code;
	this.message = message;
	this.httpStatusCode = httpStatusCode;
	this.data = data || null;
};

JsonRpcError.prototype = new Error;
JsonRpcError.name = 'JsonRpcError';
JsonRpcError.types = {
	'parse_error': {
		code: -32700,
		message: 'Parse error',
		httpStatusCode: 400,
	},
	'invalid_request': {
		code: -32600,
		message: 'Invalid request',
		httpStatusCode: 400,
	},
	'method_not_found': {
		code: -32601,
		message: 'Method not found',
		httpStatusCode: 400,
	},
	'invalid_params': {
		code: -32602,
		message: 'Invalid params',
		httpStatusCode: 400,
	},
	'internal_error': {
		code: -32603,
		message: 'Internal error',
		httpStatusCode: 500,
	},
};
JsonRpcError.constructor = JsonRpcError;
module.exports = JsonRpcError;
