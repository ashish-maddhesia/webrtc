const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const ANNOUNCED_IP = "15.206.94.127"; // <-- CHANGE if needed

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
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000
      }
    ]
  });
  console.log("Mediasoup ready");
})();

io.on("connection", socket => {
  console.log("User connected:", socket.id);

  socket.on("getRtpCapabilities", callback => {
    callback(router.rtpCapabilities);
  });

  socket.on("createTransport", async callback => {
    const transport = await router.createWebRtcTransport({
      listenIps: [{ ip: "0.0.0.0", announcedIp: ANNOUNCED_IP }],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true
    });

    transports.push({ socketId: socket.id, transport });

    callback({
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    });
  });

  socket.on("connectTransport", async ({ dtlsParameters }) => {
    const transportData = transports.find(t => t.socketId === socket.id);
    await transportData.transport.connect({ dtlsParameters });
  });

  socket.on("produce", async ({ kind, rtpParameters }, callback) => {
    const transportData = transports.find(t => t.socketId === socket.id);

    const producer = await transportData.transport.produce({
      kind,
      rtpParameters
    });

    producers.push({ socketId: socket.id, producer });

    callback({ id: producer.id });
    socket.broadcast.emit("newProducer");
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    for (let p of producers) {
      if (p.socketId === socket.id) continue;

      if (!router.canConsume({
        producerId: p.producer.id,
        rtpCapabilities
      })) continue;

      const transportData = transports.find(t => t.socketId === socket.id);

      const consumer = await transportData.transport.consume({
        producerId: p.producer.id,
        rtpCapabilities,
        paused: false
      });

      consumers.push({ socketId: socket.id, consumer });

      callback({
        id: consumer.id,
        producerId: p.producer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });

      return;
    }
  });

  socket.on("disconnect", () => {
    transports = transports.filter(t => t.socketId !== socket.id);
    producers = producers.filter(p => p.socketId !== socket.id);
    consumers = consumers.filter(c => c.socketId !== socket.id);
  });
});

/* Serve frontend directly */
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Mediasoup SFU</title>
  <style>
    video { width: 300px; margin: 10px; background: black; }
  </style>
</head>
<body>
  <h2>Mediasoup Video + Audio</h2>
  <video id="localVideo" autoplay muted></video>
  <video id="remoteVideo" autoplay></video>

  <script src="/socket.io/socket.io.js"></script>
  <script src="https://unpkg.com/mediasoup-client@3/lib/index.js"></script>
  <script>
    const socket = io();
    let device;
    let producerTransport;
    let consumerTransport;

    const localVideo = document.getElementById("localVideo");
    const remoteVideo = document.getElementById("remoteVideo");

    async function init() {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      localVideo.srcObject = stream;

      const rtpCapabilities = await new Promise(resolve =>
        socket.emit("getRtpCapabilities", resolve)
      );

      device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });

      const sendParams = await new Promise(resolve =>
        socket.emit("createTransport", resolve)
      );

      producerTransport = device.createSendTransport(sendParams);

      producerTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit("connectTransport", { dtlsParameters });
        callback();
      });

      producerTransport.on("produce", ({ kind, rtpParameters }, callback) => {
        socket.emit("produce", { kind, rtpParameters }, ({ id }) => {
          callback({ id });
        });
      });

      for (let track of stream.getTracks()) {
        await producerTransport.produce({ track });
      }

      socket.on("newProducer", consume);
    }

    async function consume() {
      const recvParams = await new Promise(resolve =>
        socket.emit("createTransport", resolve)
      );

      consumerTransport = device.createRecvTransport(recvParams);

      consumerTransport.on("connect", ({ dtlsParameters }, callback) => {
        socket.emit("connectTransport", { dtlsParameters });
        callback();
      });

      const data = await new Promise(resolve =>
        socket.emit("consume", {
          rtpCapabilities: device.rtpCapabilities
        }, resolve)
      );

      if (!data) return;

      const consumer = await consumerTransport.consume(data);

      const remoteStream = new MediaStream();
      remoteStream.addTrack(consumer.track);

      if (consumer.kind === "video") {
        remoteVideo.srcObject = remoteStream;
      } else {
        const audio = document.createElement("audio");
        audio.srcObject = remoteStream;
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
    }

    init();
  </script>
</body>
</html>
  `);
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
