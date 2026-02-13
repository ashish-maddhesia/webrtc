const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const path = require("path");
app.use(express.static(path.join(__dirname, "public")));


let worker;
let router;

let transports = [];
let producers = [];
let consumers = [];

(async () => {
  worker = await mediasoup.createWorker();
  router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000
      }
    ]
  });
  console.log("Mediasoup worker & router ready");
})();

io.on("connection", socket => {
  console.log("User connected:", socket.id);

  // 1️⃣ Send RTP Capabilities
  socket.on("getRtpCapabilities", (callback) => {
    callback(router.rtpCapabilities);
  });

  // 2️⃣ Create WebRTC Transport
  socket.on("createTransport", async (callback) => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: null }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    transports.push({
      socketId: socket.id,
      transport
    });

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  // 3️⃣ Connect Transport (DTLS)
  socket.on("connectTransport", async ({ dtlsParameters }) => {
    const transportData = transports.find(t => t.socketId === socket.id);
    await transportData.transport.connect({ dtlsParameters });
  });

  // 4️⃣ Produce (Send Video)
  socket.on("produce", async ({ kind, rtpParameters }, callback) => {
    const transportData = transports.find(t => t.socketId === socket.id);

    const producer = await transportData.transport.produce({
      kind,
      rtpParameters
    });

    producers.push({
      socketId: socket.id,
      producer
    });

    callback({ id: producer.id });

    // Notify others
    socket.broadcast.emit("newProducer");
  });

  // 5️⃣ Consume (Receive Video)
  socket.on("consume", async ({ rtpCapabilities }, callback) => {

    const producerData = producers.find(p => p.socketId !== socket.id);
    if (!producerData) return;

    if (!router.canConsume({
      producerId: producerData.producer.id,
      rtpCapabilities
    })) {
      console.log("Cannot consume");
      return;
    }

    const transportData = transports.find(t => t.socketId === socket.id);

    const consumer = await transportData.transport.consume({
      producerId: producerData.producer.id,
      rtpCapabilities,
      paused: false
    });

    consumers.push({
      socketId: socket.id,
      consumer
    });

    callback({
      id: consumer.id,
      producerId: producerData.producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters
    });
  });

  // 6️⃣ Cleanup on Disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    transports = transports.filter(t => t.socketId !== socket.id);
    producers = producers.filter(p => p.socketId !== socket.id);
    consumers = consumers.filter(c => c.socketId !== socket.id);
  });

});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
