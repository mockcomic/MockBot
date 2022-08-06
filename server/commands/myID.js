module.exports = async function (message, args, command) {
	message.channel.send(`Your username: ${message.author.username}\nYour ID: ${message.author.id}`);

} 