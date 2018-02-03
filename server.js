const Hapi = require('hapi');
const Promise = require('bluebird');
const redis = Promise.promisifyAll(require('redis'));
const server = Hapi.server({ port: 3000, host: 'localhost' });
const io = require('socket.io')(server.listener);

function redisClient() {
  const client = redis.createClient(6379, 'localhost');
  client.on('error', (err) => console.log('Redis Client Error', err));
  return client;
}

server.route({
  method: 'GET',
  path: '/messages',
  handler: async(request, h) => {
    const from = request.query.from || 0;
    const to = request.query.to || -1;
    return await redisClient().lrangeAsync('messages:1', from, to);
  }
});

server.route({
  method: 'GET',
  path: '/messages/{id}',
  handler: async(request, h) => {
    return await redisClient().lindexAsync('messages:1', request.params.id);
  }
});

server.route({
  method: 'POST',
  path: '/messages',
  handler: async(request, h) => {
    const client = redisClient();
    const message = request.payload.message;
    await client.lpushAsync('archive:1', message);
    const subscribers = await client.keysAsync('messages:1:subscribers:*');
    return await subscribers.reduce((command, subscriber) => {
      const id = subscriber.split(':').splice(-1)[0];
      return command.lpush('messages:1:queues:' + id, message);
    }, client.multi()).execAsync();
  }
});

server.route({
  method: 'POST',
  path: '/broadcast',
  handler: async(request, h) => {
    const client = redisClient();
    await client.lpushAsync('archive:1', request.payload.message);
    return await client.publishAsync('broadcast:1', request.payload.message);
  }
})

server.route({
  method: 'POST',
  path: '/messages:pop',
  handler: async(request, h) => {
    const client = redisClient();
    const key = request.payload.key || 'default';
    await client.setexAsync('messages:1:subscribers:' + key, 60, true);
    return await client.rpopAsync('messages:1:queues:' + key);
  }
});

server.route({
  method: 'POST',
  path: '/messages:bpop',
  handler: async(request, h) => {
    const timeout = (request.payload || {}).timeout || 5;
    const client = redisClient();
    const key = request.payload.key || 'default';
    await client.setexAsync('messages:1:subscribers:' + key, 60, true);
    return await client.brpopAsync('messages:1:queues:' + key);
  }
});

server.route({
  method: 'DELETE',
  path: '/messages',
  handler: async(request, h) => {
    return await redisClient().delAsync('messages:1');
  }
});

server.route({
  method: 'GET',
  path: '/archive',
  handler: async(request, h) => {
    const from = request.query.from || 0;
    const to = request.query.to || -1;
    return await redisClient().lrangeAsync('archive:1', from, to);
  }
});

const init = async () => {
  await server.register(require('inert'));

  server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {
      return h.file('./index.html');
    }
  });

  await server.start();
  console.log(`Server running at: ${server.info.uri}`);
}

io.on('connection', (socket) => {
  const sub = redisClient();
  sub.on('message', (channel, message) => {
    socket.emit('notification-message', message)
  });
  sub.subscribe('broadcast:1');
});

init().catch((err) => {
  console.log(err);
  process.exit(1);
});

 