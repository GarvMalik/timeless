const express = require('express');
const { Server } = require('ws');

const app = express();

app.use(express.static('./'));

app.get('/', (req, res) => {
  res.send(__dirname + 'index.html');
});

const wss = new Server({ port: 8085 });

const client = [];

wss.on('connection', ws => {
  client.push(ws);
  ws.on('message', data => {
    const message = JSON.parse(data);
    client.forEach(connection => {
      connection.send(JSON.stringify(message));
    });
  });
});

app.listen(4000, () => console.log('server is up'));
