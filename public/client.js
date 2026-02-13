const socket = io();

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

async function init() {

  // 1️⃣ Get Camera
  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false
  });

  localVideo.srcObject = stream;

  // 2️⃣ Get RTP Capabilities
  rtpCapabilities = await new Promise(resolve => {
    socket.emit("getRtpCapabilities", resolve);
  });

  // 3️⃣ Create Device
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });

  // 4️⃣ Create Send Transport
  const sendTransportParams = await new Promise(resolve => {
    socket.emit("createTransport", resolve);
  });

  producerTransport = device.createSendTransport(sendTransportParams);

  producerTransport.on("connect", ({ dtlsParameters }, callback) => {
    socket.emit("connectTransport", { dtlsParameters });
    callback();
  });

  producerTransport.on("produce", ({ kind, rtpParameters }, callback) => {
    socket.emit("produce", { kind, rtpParameters }, ({ id }) => {
      callback({ id });
    });
  });

  // 5️⃣ Produce Video
  producer = await producerTransport.produce({
    track: stream.getVideoTracks()[0]
  });

  // 6️⃣ Listen for new producers
  socket.on("newProducer", async () => {
    await consume();
  });

}

async function consume() {

  const recvTransportParams = await new Promise(resolve => {
    socket.emit("createTransport", resolve);
  });

  consumerTransport = device.createRecvTransport(recvTransportParams);

  consumerTransport.on("connect", ({ dtlsParameters }, callback) => {
    socket.emit("connectTransport", { dtlsParameters });
    callback();
  });

  const data = await new Promise(resolve => {
    socket.emit("consume", {
      rtpCapabilities: device.rtpCapabilities
    }, resolve);
  });

  consumer = await consumerTransport.consume({
    id: data.id,
    producerId: data.producerId,
    kind: data.kind,
    rtpParameters: data.rtpParameters
  });

  const remoteStream = new MediaStream();
  remoteStream.addTrack(consumer.track);
  remoteVideo.srcObject = remoteStream;
}

init();
