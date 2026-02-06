export class ChessMeshtastic {
  constructor(options = {}) {
    const {
      portnum = 1,
      opponentNodeId = null,
      gameId = null,
      baudRate = 921600
    } = options;

    this.portnum = portnum;
    this.opponentNodeId = opponentNodeId;
    this.gameId = gameId;
    this.baudRate = baudRate;

    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;

    this.root = null;
    this.ToRadio = null;
    this.FromRadio = null;
    this.MeshPacket = null;
    this.Data = null;

    this.myNodeNum = null;
    this.loggedMyNodeNum = false;
    this.myShortName = null;
    this.nodeInfoByNum = new Map();
    this.channelsByIndex = new Map();
    this.configId = Math.floor(Math.random() * 0xffff);
    this.heartbeatTimer = null;
    this.onMoveCallback = null;
    this.onChannelCallback = null;
    this.onNodeInfoCallback = null;
    this.rxBuffer = new Uint8Array(0);
    this.maxFrameSize = 1024 * 64;
    this.framingByte1 = 148;
    this.framingByte2 = 195;
  }

  async connect() {
    try {
      await this._loadSchema();

      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: this.baudRate });

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.connected = true;

      console.log("[CHESS] Connected to Meshtastic radio");
      await this._sendWantConfig();
      this._startHeartbeat();
      this._listen();
    } catch (err) {
      console.error("[CHESS] Connection error:", err);
      await this._cleanup();
      throw err;
    }
  }

  async sendMove(moveObj) {
    return this.sendPayload(moveObj, {
      destination: this.opponentNodeId ?? 0xffffffff,
      channel: 0
    });
  }

  async sendPayload(payloadObj, options = {}) {
    if (!this.connected) {
      console.warn("[CHESS] Not connected to Meshtastic");
      return;
    }
    if (this.myNodeNum == null) {
      console.warn("[CHESS] myNodeNum not known yet; sending anyway");
    }

    try {
      const { destination = 0xffffffff, channel = 0 } = options;
      const json = JSON.stringify(payloadObj);
      const payloadBytes = new TextEncoder().encode(json);

      const data = this.Data.create({
        portnum: this.portnum,
        payload: payloadBytes,
        wantResponse: false
      });

      const meshPacketFields = {
        to: destination,
        channel,
        id: this._nextPacketId(),
        wantAck: true,
        priority: 70,
        decoded: data
      };

      if (this.myNodeNum != null) {
        meshPacketFields.from = this.myNodeNum;
      }

      const meshPacket = this.MeshPacket.create(meshPacketFields);

      const toRadio = this.ToRadio.create({ packet: meshPacket });
      const buffer = this.ToRadio.encode(toRadio).finish();
      const framed = this._framePacket(buffer);

      await this.writer.write(framed);
      console.log("[CHESS TX]", payloadObj);
    } catch (err) {
      console.error("[CHESS TX ERROR]", err);
      throw err;
    }
  }

  onMove(callback) {
    this.onMoveCallback = callback;
  }

  onChannel(callback) {
    this.onChannelCallback = callback;
  }

  onNodeInfo(callback) {
    this.onNodeInfoCallback = callback;
  }

  async disconnect() {
    this.connected = false;
    this._stopHeartbeat();
    await this._cleanup();
    console.log("[CHESS] Disconnected");
  }

  async _cleanup() {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      }
    } catch (_) {
      this.reader = null;
    }

    try {
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
    } catch (_) {
      this.writer = null;
    }

    try {
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch (_) {
      this.port = null;
    }
  }

  async _loadSchema() {
    if (this.root) return;

    const protobuf = window.protobuf;
    if (!protobuf) {
      throw new Error("protobuf runtime missing. Load vendor/protobuf.min.js first.");
    }

    const response = await fetch("meshtastic_bundle.json");
    const bundle = await response.json();
    this.root = protobuf.Root.fromJSON(bundle);

    this.ToRadio = this.root.lookupType("meshtastic.ToRadio");
    this.FromRadio = this.root.lookupType("meshtastic.FromRadio");
    this.MeshPacket = this.root.lookupType("meshtastic.MeshPacket");
    this.Data = this.root.lookupType("meshtastic.Data");
  }

  async _listen() {
    console.log("[CHESS RX] Listening for packets...");

    while (this.connected) {
      try {
        const { value, done } = await this.reader.read();
        if (done) {
          console.warn("[CHESS RX] Reader closed by device");
          break;
        }
        if (!value || value.length === 0) continue;

        this._appendRxBuffer(value);
        this._drainFrames();
      } catch (err) {
        console.error("[CHESS RX ERROR]", err);
        break;
      }
    }

    await this.disconnect();
  }

  _appendRxBuffer(chunk) {
    const merged = new Uint8Array(this.rxBuffer.length + chunk.length);
    merged.set(this.rxBuffer, 0);
    merged.set(chunk, this.rxBuffer.length);
    this.rxBuffer = merged;
  }

  _drainFrames() {
    let guard = 0;
    while (this.rxBuffer.length > 0 && guard < 2048) {
      guard += 1;

      const framingIndex = this._findFramingIndex(this.rxBuffer);
      if (framingIndex === -1) {
        this.rxBuffer = new Uint8Array(0);
        return;
      }

      if (framingIndex > 0) {
        this.rxBuffer = this.rxBuffer.slice(framingIndex);
      }

      if (this.rxBuffer.length < 4) return;

      const msb = this.rxBuffer[2];
      const lsb = this.rxBuffer[3];
      const frameLength = (msb << 8) | lsb;
      const totalLength = 4 + frameLength;

      if (frameLength <= 0 || frameLength > this.maxFrameSize) {
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }

      if (this.rxBuffer.length < totalLength) return;

      const frame = this.rxBuffer.slice(4, totalLength);
      if (!this._tryHandleFrame(frame)) {
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }

      this.rxBuffer = this.rxBuffer.slice(totalLength);
    }
  }

  _tryHandleFrame(frame) {
    try {
      const msg = this.FromRadio.decode(frame);
      if (msg.myInfo && msg.myInfo.myNodeNum != null) {
        this.myNodeNum = msg.myInfo.myNodeNum;
        if (!this.loggedMyNodeNum) {
          console.log("[CHESS] myNodeNum:", this.myNodeNum);
          this.loggedMyNodeNum = true;
        }
      }

      if (msg.nodeInfo) {
        const nodeNum = msg.nodeInfo.num;
        if (nodeNum != null) {
          this.nodeInfoByNum.set(nodeNum, msg.nodeInfo);
          if (this.myNodeNum != null && nodeNum === this.myNodeNum) {
            const shortName = msg.nodeInfo.user?.shortName;
            if (shortName) {
              this.myShortName = shortName;
            }
          }
          if (this.onNodeInfoCallback) {
            this.onNodeInfoCallback(msg.nodeInfo);
          }
        }
      }

      if (msg.channel) {
        const channelIndex = msg.channel.index;
        if (channelIndex != null) {
          this.channelsByIndex.set(channelIndex, msg.channel);
          if (this.onChannelCallback) {
            this.onChannelCallback(msg.channel);
          }
        }
      }

      const decoded = msg?.packet?.decoded;
      if (!decoded) return;

      if (decoded.portnum !== this.portnum) return;

      let rawText = "";
      if (decoded.payload && decoded.payload.length) {
        rawText = new TextDecoder().decode(decoded.payload);
      } else if (decoded.text) {
        rawText = decoded.text;
      }

      if (!rawText) return;

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        console.warn("[CHESS RX] Non-JSON payload:", rawText);
        return;
      }

      console.log("[CHESS RX]", parsed);
      if (this.onMoveCallback) {
        this.onMoveCallback(parsed, msg);
      }
      return true;
    } catch (err) {
      console.warn("[CHESS RX] Failed to decode frame", err);
      return false;
    }
  }

  _findFramingIndex(buffer) {
    for (let i = 0; i + 1 < buffer.length; i++) {
      if (buffer[i] === this.framingByte1 && buffer[i + 1] === this.framingByte2) {
        return i;
      }
    }
    return -1;
  }

  _framePacket(payload) {
    const length = payload.length;
    const header = new Uint8Array(4);
    header[0] = this.framingByte1;
    header[1] = this.framingByte2;
    header[2] = (length >> 8) & 0xff;
    header[3] = length & 0xff;

    const framed = new Uint8Array(header.length + payload.length);
    framed.set(header, 0);
    framed.set(payload, header.length);
    return framed;
  }

  _nextPacketId() {
    if (crypto?.getRandomValues) {
      const buffer = new Uint32Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0];
    }
    return (Math.random() * 0xffffffff) >>> 0;
  }

  async _sendWantConfig() {
    try {
      const toRadio = this.ToRadio.create({ wantConfigId: this.configId });
      const buffer = this.ToRadio.encode(toRadio).finish();
      const framed = this._framePacket(buffer);
      await this.writer.write(framed);
    } catch (err) {
      console.warn("[CHESS] Failed to request config:", err);
    }
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      const toRadio = this.ToRadio.create({ heartbeat: { nonce: Date.now() & 0xffff } });
      const buffer = this.ToRadio.encode(toRadio).finish();
      const framed = this._framePacket(buffer);
      this.writer.write(framed).catch((err) => {
        console.warn("[CHESS] Heartbeat error:", err);
      });
    }, 60 * 1000);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

}
