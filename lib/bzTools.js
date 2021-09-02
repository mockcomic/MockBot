let listeners = {}


const register = function (eventName, recipient) {
	// add this recipient to the event's listeners array...
	(listeners[eventName] || (listeners[eventName] = [])).push(recipient)

	// return a function that, when called, removes this recipient from the event's listeners array...
	return () => {
		let idx = listeners[eventName].indexOf(recipient)

		if (idx >= 0) {
			listeners[eventName].splice(idx, 1)
		}
	}
}


const broadcast = function (eventName, message) {
	let data = {
		name: eventName
	}

	for (let key in message) {
		data[key] = message[key]
	}

	for (let recipient of (listeners[eventName] || [])) {
		recipient(data)
	}
}
module.exports = {
	broadcast,
	register,
}
