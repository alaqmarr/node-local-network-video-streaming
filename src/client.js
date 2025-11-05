// src/client.js
import io from 'socket.io-client';
import mediasoupClient from 'mediasoup-client';

const socket = io({ autoConnect: true });

const videoEl = document.getElementById('video') || createVideoElement();
const ipEl = document.getElementById('ip');
const macEl = document.getElementById('mac');

function createVideoElement() {
  const v = document.createElement('video');
  v.id = 'video';
  v.autoplay = true;
  v.playsInline = true;
  v.muted = false;
  v.style.width = '100vw';
  v.style.height = '100vh';
  v.style.objectFit = 'cover';
  document.body.appendChild(v);
  return v;
}

async function init() {
  try {
    // fetch server info
    const res = await fetch('/api/info');
    const info = await res.json();
    if (ipEl) ipEl.textContent = info.ip || '';
    if (macEl) macEl.textContent = info.mac || '';

    // Step 1: get router RTP capabilities
    const rtpCapabilities = await new Promise((resolve, reject) => {
      socket.emit('getRouterRtpCapabilities', null, (data) => {
        if (!data) return reject(new Error('No rtpCapabilities'));
        resolve(data);
      });
    });

    // Step 2: create mediasoup device
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // Step 3: ask server to create a WebRTC transport for this client
    const transportInfo = await new Promise((resolve, reject) => {
      socket.emit('createTransport', null, (t) => {
        if (!t) return reject(new Error('createTransport failed'));
        resolve(t);
      });
    });

    // Step 4: create recv transport on client
    const recvTransport = device.createRecvTransport({
      id: transportInfo.id,
      iceParameters: transportInfo.iceParameters,
      iceCandidates: transportInfo.iceCandidates,
      dtlsParameters: transportInfo.dtlsParameters
    });

    // notify server when transport needs to connect (DTLS)
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.emit('connectTransport', { dtlsParameters }, (res) => {
        if (res && res.ok) callback();
        else errback(new Error('connectTransport fail'));
      });
    });

    // Step 5: ask server to consume producers (server will create producers from FFmpeg RTP)
    const consumeResp = await new Promise((resolve, reject) => {
      socket.emit('consume', { rtpCapabilities: device.rtpCapabilities }, (resp) => {
        if (!resp) return reject(new Error('consume failed'));
        resolve(resp);
      });
    });

    if (!consumeResp.consumers || consumeResp.consumers.length === 0) {
      console.warn('No consumers available yet. Retrying in 1s...');
      setTimeout(init, 1000);
      return;
    }

    // For each consumer, create a consumer on recvTransport and attach track to element(s)
    for (const c of consumeResp.consumers) {
      const consumer = await recvTransport.consume({
        id: c.id,
        producerId: c.producerId,
        kind: c.kind,
        rtpParameters: c.rtpParameters
      });

      // Build stream and attach
      const stream = new MediaStream();
      stream.addTrack(consumer.track);

      if (consumer.kind === 'video') {
        videoEl.srcObject = stream;
        try { await videoEl.play(); } catch (e) { console.warn('video play failed', e); }
      } else if (consumer.kind === 'audio') {
        // create hidden audio element
        let audioEl = document.querySelector('#remote-audio');
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'remote-audio';
          audioEl.autoplay = true;
          audioEl.playsInline = true;
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = stream;
        try { await audioEl.play(); } catch (e) { console.warn('audio play fail', e); }
      }

      // resume consumer if paused
      socket.on('consumer-resume-' + c.id, async () => {
        try { await consumer.resume(); } catch (e) { console.warn('resume error', e); }
      });
    }

    // keepalive / info
    socket.on('stream-status', (s) => {
      console.log('stream-status', s);
    });
  } catch (err) {
    console.error('init error', err);
    setTimeout(init, 1500);
  }
}

window.addEventListener('load', () => {
  init();
});
