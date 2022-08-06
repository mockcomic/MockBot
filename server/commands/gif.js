require("dotenv").config();

const tenorKey = process.env.TENORKEY
const fetch = require('node-fetch')

module.exports = async function (message, args, commands) {

  let url = `https://api.tenor.com/v1/search?q=${args}&key=${tenorKey}&ContentFilter=off`
  let response = await fetch(url);
  let json = await response.json();
  const index = Math.floor(Math.random() * json.results.length)

  let result = json.results[index] ?
    json.results[index].url :
    "No gif was found with your search parameters.";

  message.channel.send(result)
}