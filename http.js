var http = function() {

var tcp = chrome.sockets.tcp,
	tcpServer = chrome.sockets.tcpServer,
	Event = chrome.Event || eventEmitter.Event;

if (!tcp || !tcpServer || !Event)
	return {};

var STATUS_CODES = {
	200: 'OK',
	403: 'Forbidden',
	404: 'Not Found',
	405: 'Method Not Allowed',
	418: 'I\'m a teapot',		// RFC 2324
	501: 'Not Implemented'
};

var ESSENTIAL_YOUTUBE_HEADERS =
	'Access-Control-Allow-Origin: http://www.youtube.com\r\n' +
	'Access-Control-Allow-Credentials: true\r\n' +
	'Timing-Allow-Origin: http://www.youtube.com\r\n' +
	'X-Content-Type-Options: nosniff\r\n' +
	'Server: gvs 1.0\r\n\r\n';

function ab2str(buf) {
	return String.fromCharCode.apply(null, new Uint8Array(buf));
}
function str2ab(str) {
	var i, len = str.length,
		buf = new ArrayBuffer(len),
		bufView = new Uint8Array(buf);
	for (i = 0; i < len; i++)
		bufView[i] = str.charCodeAt(i);
	return buf;
}
function warn(state, socket, code) {
	console.warn('[%d][%s] ' + chrome.runtime.lastError.message + ' (%d)', socket, state, code);
}

/**
 * Users can register their callbacks on these events:
 *
 *   Server.onRequest
 *   Server.onProxyRequest
 *
 * A callback funcion looks like this:
 *
 *   function(IngressMessage req, EgressMessage response) { ... }
 *
 * The relationship among Server, Connection and Pipe classes:
 *
 *   Server -- accept --> new Connection (client connection to be served)
 *          ------------> new Connection
 *                        ----> new Pipe (proxy connection to the target)
 *          ------------> new Connection
 *                        ----> new Pipe
 *          ------------> new Connection
 *          ------------> ...
 */
function Server(opt_requestListener) {
	this.socketId_ = null;
	this.connections_ = [];
	this.acceptListener_ = undefined;

	this.onRequest = new Event();
	this.onProxyRequest = new Event();

	if (opt_requestListener)
		this.onRequest.addListener(opt_requestListener);
}

Server.prototype.listen = function(port, opt_address) {
	var t = this;

	tcpServer.create({}, function(server) {
		tcpServer.listen(server.socketId, opt_address || '0.0.0.0', port, function(result) {
			if (result < 0) {
				warn('listen on server', server.socketId, result);
				return;
			}
			t.socketId_ = server.socketId;
			t.acceptListener_ = establishConnectionForServer;
			tcpServer.onAccept.addListener(t.acceptListener_);
		});
	});

	function establishConnectionForServer(my) {
		if (my.socketId != t.socketId_)
			return;
		var c = new Connection(t, my.clientSocketId);
		t.connections_.push(c);
		c.establish();
	}
};

Server.prototype.close = function(opt_connection) {
	if (!this.socketId_)
		return;

	// close the given connection
	if (opt_connection) {
		var i = this.connections_.indexOf(opt_connection);
		if (i > -1)
			this.connections_.splice(i, 1);
		return;
	}

	// or close the server
	tcpServer.onAccept.removeListener(this.acceptListener_);
	tcpServer.disconnect(this.socketId_);
	tcpServer.close(this.socketId_);

	for (var i = this.connections_.length - 1; i >= 0; i--)
		this.connections_[i].close();
};

/**
 * Per-client logic, created when accepting a connection from Server,
 * base of Pipe class.
 */
function Connection(server, socket) {
	this.owner_ = server;
	this.socketId_ = socket;
	this.closed_ = false;

	// instance of Pipe class, indicates a proxy connection's existed.
	this.pipe_ = null;

	// each client has its own listeners,
	// for chrome.sockets.tcp.(onReceive|onReceiveError) events.
	this.receiveListener_ = undefined;
	this.receiveErrorListener_ = undefined;
}

Connection.prototype.establish = function() {
	this.receiveListener_ = dataFromClient.bind(this);
	this.receiveErrorListener_ = errorFromClient.bind(this);

	tcp.onReceive.addListener(this.receiveListener_);
	tcp.onReceiveError.addListener(this.receiveErrorListener_);
	tcp.setPaused(this.socketId_, false);

	function dataFromClient(my) {
		if (my.socketId != this.socketId_)
			return;

		var req = new IngressMessage(this, my.data),
			res = new EgressMessage(req);

		this.owner_.onRequest.dispatch(req, res);
	}

	function errorFromClient(my) {
		if (my.socketId != this.socketId_)
			return;
		console.log('[%d][receive error] Code: %d.', my.socketId, my.resultCode);
		this.close();
	}
};

Connection.prototype.close = function() {
	if (this.closed_)
		return;
	this.closed_ = true;

	console.log('[%d][Connection] Being closed.', this.socketId_);

	// remove self from server's connection queues.
	this.owner_.close(this);

	tcp.onReceive.removeListener(this.receiveListener_);
	tcp.onReceiveError.removeListener(this.receiveErrorListener_);
	tcp.disconnect(this.socketId_);
	tcp.close(this.socketId_);

	if (this.pipe_)
		this.pipe_.close();
};

/**
 * Maintains the state of the connection, e.g. a connection in proxying state
 * should have different logic in receiving client requests.
 *
 * When a connection is going to be proxyed, it unregisters its current regular
 * listener from onReceive, and registers it with the new one, which will
 * process the requests in onProxyRequest event.
 *
 * original flow, the initial state:
 *
 *   request ---------> onRequest
 *           |
 *           \-- x ---> onProxyRequest
 *
 * after pipe() be invoked:
 *
 *   request --- x ---> onRequest
 *           |
 *           \--------> onProxyRequest
 *
 * The state of a connection won't be changed back, since that indicates
 * there is an error and the connection will simply be closed.
 */
Connection.prototype.transitStates = function(receiveListener) {
	if (!this.pipe_)
		return;

	tcp.onReceive.removeListener(this.receiveListener_);
	this.receiveListener_ = receiveListener.bind(this);
	tcp.onReceive.addListener(this.receiveListener_);
};

/**
 * Send the data out to the connection, where data is of type of ArrayBuffer.
 */
Connection.prototype.send = function(data) {
	var t = this;

	// FIXME: Socket happens to be closed while data is being sent.
	tcp.send(this.socketId_, data, function(info) {
		if (info.resultCode < 0) {
			warn('be sent', t.socketId_, info.resultCode);
			t.close();
			return;
		}
	});
};

Connection.prototype.pipe = function(host, data, opt_mirrorCallback) {
	if (this.pipe_ instanceof ReplicablePipe && typeof opt_mirrorCallback == 'function') {
			this.pipe_.mirrorCallback = opt_mirrorCallback;
		this.pipe_.send(data);
		return;
	}

	var t = this,
		p = host.indexOf(':'),
		port = 80;

	if (p > 0) {
		port = parseInt(host.slice(p + 1));
		host = host.slice(0, p);
	}

	tcp.create({}, function(pipe) {
		if (typeof opt_mirrorCallback == 'function') {
			t.pipe_ = new ReplicablePipe(t, pipe.socketId);
			t.pipe_.mirrorCallback = opt_mirrorCallback;
		} else t.pipe_ = new Pipe(t, pipe.socketId);

		t.pipe_.establish(host, port, data);
	});
};

/**
 * Proxy connection class.
 */
function Pipe(client, socket) {
	Connection.call(this, client, socket);
}

Pipe.prototype.send = Connection.prototype.send;
Pipe.prototype.establish = function(host, port, data) {
	var t = this;

	this.receiveListener_ = dataFromPeer.bind(this);
	this.receiveErrorListener_ = dataErrorFromPeer.bind(this);
	tcp.onReceive.addListener(this.receiveListener_);
	tcp.onReceiveError.addListener(this.receiveErrorListener_);

	tcp.connect(this.socketId_, host, port, function(result) {
		if (result < 0) {
			warn('connect from pipe', t.socketId_, result);
			t.close();
			return;
		}
		t.owner_.transitStates(dataFromClientOnPipingState);
		t.send(data);
	});

	// this will be bound to connection.
	function dataFromClientOnPipingState(my) {
		if (my.socketId != this.socketId_)
			return;

		var req = new IngressMessage(this, my.data),
			res = new EgressMessage(req);

		this.owner_.onProxyRequest.dispatch(req, res);
		this.pipe_.send(my.data);
	}

	function dataFromPeer(my) {
		if (my.socketId != this.socketId_)
			return;
		this.owner_.send(my.data);
	}

	function dataErrorFromPeer(my) {
		if (my.socketId != this.socketId_)
			return;
		console.log('[%d][receive error on pipe] Code: %d.', my.socketId, my.resultCode);
		this.close();
	}
};

Pipe.prototype.close = function() {
	if (this.closed_)
		return;
	this.closed_ = true;

	console.log('[%d][Pipe] Being closed.', this.socketId_);

	tcp.onReceive.removeListener(this.receiveListener_);
	tcp.onReceiveError.removeListener(this.receiveErrorListener_);
	tcp.disconnect(this.socketId_);
	tcp.close(this.socketId_);

	this.owner_.close();
};

function ReplicablePipe(client, socket) {
	Pipe.call(this, client, socket);

	this.buffer_ = null;
	this.bytesLeft_ = -1;
	this.mirrorCallback = undefined;
}

ReplicablePipe.prototype.send = Pipe.prototype.send;
ReplicablePipe.prototype.establish = function(host, port, data) {
	var t = this;

	this.receiveListener_ = dataFromPeer.bind(this);
	this.receiveErrorListener_ = dataErrorFromPeer.bind(this);
	tcp.onReceive.addListener(this.receiveListener_);
	tcp.onReceiveError.addListener(this.receiveErrorListener_);

	tcp.connect(this.socketId_, host, port, function(result) {
		if (result < 0) {
			warn('connect from pipe', t.socketId_, result);
			t.close();
			return;
		}
		t.owner_.transitStates(dataFromClientOnPipingState);
		t.send(data);
	});

	// this will be bound to connection.
	function dataFromClientOnPipingState(my) {
		if (my.socketId != this.socketId_)
			return;

		var req = new IngressMessage(this, my.data),
			res = new EgressMessage(req);

		this.owner_.onProxyRequest.dispatch(req, res);
	}

	function dataFromPeer(my) {
		if (my.socketId != this.socketId_)
			return;

		if (this.buffer_ == null) {
			var msg = new IngressMessage(null, my.data);
			if (msg.http) {
				this.bytesLeft_ = parseInt(msg.header('content-length'));
				this.buffer_ = [];

				var d = my.data.slice(msg.bodyBegin);
				if (d.byteLength > 0) {
					this.bytesLeft_ -= d.byteLength;
					this.buffer_.push(d);
				}
			}
		} else {
			this.buffer_.push(my.data);
			this.bytesLeft_ -= my.data.byteLength;
		}

		if (this.bytesLeft_ <= 0 && this.buffer_) {
			this.mirrorCallback(this.buffer_);
			this.buffer_ = null;
		}

		this.owner_.send(my.data);
	}

	function dataErrorFromPeer(my) {
		if (my.socketId != this.socketId_)
			return;
		console.log('[%d][receive error on pipe] Code: %d.', my.socketId, my.resultCode);
		this.close();
	}
};

/**
 *  ReplicablePipe doesn't need to close Client connection.
 */
ReplicablePipe.prototype.close = function() {
	if (this.closed_)
		return;
	this.closed_ = true;

	console.log('[%d][ReplicablePipe] Being closed.', this.socketId_);

	tcp.onReceive.removeListener(this.receiveListener_);
	tcp.onReceiveError.removeListener(this.receiveErrorListener_);
	tcp.disconnect(this.socketId_);
	tcp.close(this.socketId_);

	this.owner_.pipe_ = null;
};

/**
 * Encapsulates an incoming HTTP message, the first argument to onRequest event.
 * Note that the HTTP headers are only parsed once and parsed when needed.
 */
function IngressMessage(client, data) {
	this.client = client;
	// data of ArrayBuffer type
	this.buffer = data;
	this.data = ab2str(data);
	this.http = true;

	this.headers_ = null;

	// when receives request from clients
	this.method = '';
	this.uri = '';
	// when receives response from pipes
	this.status = null;
	this.reason = '';

	this.headersBegin = -1;
	this.headersEnd = -1;
	this.bodyBegin = -1;

	(function determineMessageType() {
		var	firstCRLF = this.data.indexOf('\r\n', 13),
			symbols = this.data.substring(0, firstCRLF).split(' ', 3);

		switch(symbols[0]) {
		case 'GET': case 'POST': case 'PUT': case 'DELETE':
			this.method = symbols[0];
			this.uri = symbols[1];
			break;
		case 'HTTP/1.1':
			this.status = symbols[1];
			this.reason = symbols[2];
			break;
		default:
			this.http = false;
			return;
		}
		this.headersBegin = firstCRLF + 2;
	}).call(this);
}

IngressMessage.prototype.headers = function() {
	if (this.headers_)
		return this.headers_;
	return this.parse().headers_;
}

IngressMessage.prototype.header = function(key) {
	if (this.headers_)
		return this.headers_[key];
	return this.parse().headers_[key];
}

IngressMessage.prototype.parse = function() {
	var	headers = {},
		message = this.data,
		headersBegin = this.headersBegin,
		headersEnd;

	this.headersEnd = headersEnd = message.indexOf('\r\n\r\n', headersBegin);

	if (headersEnd != -1) {
		var line, colon, i,
			headerLines = message.substring(headersBegin, headersEnd).split('\r\n');
		for (i = headerLines.length; i-- > 0;) {
			line = headerLines[i];
			colon = line.indexOf(':', 1);

			if (colon != -1)
				headers[line.substring(0, colon).toLowerCase()] = line.substring(colon + 2);
		}

		this.bodyBegin = headersEnd + 4;
	}

	this.headers_ = headers;
	return this;
};

/**
 * Takes an IngressMessage object to encapsulate a response message.
 */
function EgressMessage(ingressMessage) {
	this.req_ = ingressMessage;
	this.headed_ = false;
	this.keepAlive_ = false;
}

EgressMessage.prototype.writeHead = function(code, headers) {
	var out = 'HTTP/1.1 ' + code + ' ' + STATUS_CODES[code] || 'Maaya saikou';

	if (this.req_.header('proxy-connection') == 'keep-alive' || this.req_.header('connection') == 'keep-alive') {
		this.keepAlive_ = true;
		headers['Connection'] = 'keep-alive';
	}

	if (typeof headers == 'object') {
		Object.getOwnPropertyNames(headers).forEach(function(field) {
			out += '\r\n' + field + ': ' + headers[field];
		});
	}
	out += '\r\n' + ESSENTIAL_YOUTUBE_HEADERS;

	this.req_.client.send(str2ab(out));
	this.headed_ = true;
};

EgressMessage.prototype.end = function(opt_data) {
	if (!this.headed_)
		throw new Error('writeHead() must be called before calling end().');

	if (opt_data instanceof ArrayBuffer)
		this.req_.client.send(opt_data);
	else if (typeof opt_data == 'string' || opt_data instanceof String)
		this.req_.client.send(str2ab(opt_data));

	if (!this.keepAlive_)
		this.req_.client.close();
};

/**
 * Usage:
 *
 *   http.server(function(req, response) {
 *     ...
 *     req.client.pipe(req.header('host'), req.data);
 *   });
 *
 *   or
 *
 *   var server = http.server();
 *   server.onRequest.addListener(function() { ... });
 *   server.onProxyRequest.addListener(function() { ... });
 */
return {
	server: function(requestListener) {
		return new Server(requestListener);
	}
};

}();
