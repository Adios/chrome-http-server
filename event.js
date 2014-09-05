var eventEmitter = function() {
/**
 * If opt_func is given, returns an instance of the being mixed class.
 */
function eventEmitter(opt_func) {
	return opt_func	? new (mixin(opt_func, EventEmitter))
					: new EventEmitter;
}

function mixin(subject, var_objs) {
	var proto, i, p, len = arguments.length;

	for (i = 0; i++ < len - 1;) {
		proto = arguments[i].prototype;
		for (p in proto) {
			subject.prototype[p] = proto[p];
		}
	}
	return subject;
}

function EventEmitter() {
	this.events_ = {};
}

EventEmitter.prototype.emit = function(type, var_args) {
	if (!this.events_)
		EventEmitter.call(this);

	var listener = listeners = this.events_[type];

	if (!listener)
		return false;
	else if (typeof listener == 'function') {
		switch (arguments.length) {
		case 1:
			listener.call();
			break;
		case 2:
			listener.call(null, arguments[1]);
			break;
		case 3:
			listener.call(null, arguments[1], arguments[2]);
			break;
		default:
			listener.apply(null, Array.prototype.slice.call(arguments, 1));
		}
	} else {
		var len = listeners.length;
		for (var i = 0; i < len; i++)
			listeners[i].apply(null, Array.prototype.slice.call(arguments, 1));
	}

	return true;
};

EventEmitter.prototype.addListener = EventEmitter.prototype.on = function(type, listener) {
	if (!this.events_)
		EventEmitter.call(this);

	if (typeof listener != 'function')
		throw TypeError('listener must be a function.');

	// prevent creating an array if there is only one listener.
	if (!this.events_[type])
		this.events_[type] = listener;
	else if (typeof this.events_[type] == 'object')
		this.events_[type].push(listener);
	else
		this.events_[type] = [this.events_[type], listener];

	return this;
};

EventEmitter.prototype.removeListener = function(type, listener) {
	if (!this.events_)
		EventEmitter.call(this);

	if (typeof listener != 'function')
		throw TypeError('listener must be a function.');

	if (!this.events_[type])
		return this;

	var list = this.events_[type],
		len = list.length,
		pos = -1;

	if (list === listener)
		delete this.events_[type];
	else {
		for (var i = len; i-- > 0;) {
			if (list[i] === listener) {
				pos = i;
				break;
			}
		}

		if (pos < 0)
			return this;

		if (len == 1) {
			list.length = 0;
			delete this.events_[type];
		} else {
			list.splice(pos, 1);
		}
	}

	return this;
};

/**
 * There are 2 fasions to employ eventEmitter() in users' code:
 *
 *     function Server() {}
 *
 * 1)  var server = eventEmitter(Server);
 *     server.addListener('onMessage', function() {}).emit('onMessage');
 *
 * 2)  var server = new Server();
 *     server.onMessage = new eventEmitter.Event('optional name');
 *     server.onMessage.addListener(function() {}).dispatch();
 *
 * I order to provide the second usage fasion, the library maintains an
 * EventEmitter object as a singleton containing all instances of Event()
 * that registers each of themself as a unique event type in the loop.
 */
function EventLoop() {
	this.instance_ = undefined;
	this.count_ = 0;
}
EventLoop.prototype = {
	get: function() {
		if (!this.instance_)
			this.instance_ = new EventEmitter();
		return this.instance_;
	},
	count: function() { return this.count_++; }
};

function EventWrapper(opt_name) {
	this.loop = eventLoop.get();
	this.name = opt_name || '_MaayaErikaYukachiEvent_' + eventLoop.count();
}
EventWrapper.prototype = {
	addListener: function(listener) {
		this.loop.addListener(this.name, listener);
		return this;
	},
	removeListener: function(listener) {
		this.loop.removeListener(this.name, listener);
		return this;
	},
	dispatch: function(var_args) {
		var args = Array.prototype.slice.call(arguments);
		args.unshift(this.name);
		return this.loop.emit.apply(this.loop, args);
	}
};

var eventLoop = new EventLoop();
eventEmitter.Event = EventWrapper;
eventEmitter.EventEmitter = EventEmitter;

return eventEmitter;

}();
