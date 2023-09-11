import { Component, createSignal, onMount, onCleanup, createEffect, Switch, Match, Show, Signal, Accessor, untrack } from 'solid-js';
import { Graph, buildGrid, resolveColor, v2f, PlotChannel, intColorToRgba } from './DoscPlot';
import { createDummyConnection, DummyConnection, createDataChannel, serverConnection, RTCChannel } from './webrtc_connection'
import { decodeScopeFrame, encodeScopeFrame, FrameData, frameDifference, nextFrame, processFrame, ScopeFrame } from './scope_frame'
import { Socket, io } from 'socket.io-client';
import { ADT } from 'ts-adt';

const GraphSinNoise = () => {
  const [noise, setNoise] = createSignal([] as number[]);
  const [clean, setClean] = createSignal([] as number[]);
  const [total, setTotal] = createSignal([] as number[]);
  const [snr, setSnr] = createSignal(10);
  const [amplitude, setAmplitude] = createSignal(1);
  const nPoints = 1000;
  const grid = buildGrid(6, 6);
  const maxChannels = 3
  const xs = Array.from({ length: nPoints }, (_, i) => i * 2 / nPoints - 1)

  onMount(() => {
    const interval = setInterval(() => {
      const snr_ = snr()
      const amp = amplitude();
      setNoise(xs.map(() => (Math.random() - .5) / snr_ * amp))
    }, 1 / 60 * 1000)

    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    const amp = amplitude();
    setClean(xs.map((x) => Math.sin(x * Math.PI) * amp));
  })

  createEffect(() => {
    const [clean_, noise_] = [clean(), noise()]
    setTotal(xs.map((_, i) => clean_[i] + noise_[i]))
  })

  let gray = resolveColor("gray");
  let red = resolveColor("red");

  return <>
    <Graph bgColor="cornsilk" maxChannels={maxChannels} channels={[
      {
        color: gray,
        yOffset: 0, yScale: 1,
        data: { edges: grid }
      },
      {
        color: red,
        yOffset: 0, yScale: 1,
        data: { linePoints: ((t) => xs.map((x, i) => [x, t[i]]))(total()) }
      },
    ]} />
    <div style="display: flex; flex-direction: row;">
      <input type="range" min={1} max={10} value={snr()} onInput={(e) => setSnr(e.target.valueAsNumber)} />
      <p>SNR: {snr()}</p>
    </div>
    <div style="display: flex; flex-direction: row;">
      <input type="range" min={0} max={100} value={amplitude() * 100} onInput={(e) => setAmplitude(e.target.valueAsNumber / 100)} />
      <p>Amplitude: {amplitude()}</p>
    </div>
  </>;
}

const GraphLinesDisconnected = () => {
  const [channels, setChannels] = createSignal([] as PlotChannel[]);
  const [lineData, setLineData] = createSignal([] as v2f[])
  const [lines, setLines] = createSignal(10);
  const [scale, setScale] = createSignal(1);
  const maxChannels = 5;
  let colors = Array.from(
    { length: maxChannels }, () => intColorToRgba(Math.random() * 255 ** 3)
  );
  const grid = buildGrid(5, 5);

  createEffect(() =>
    setLineData(Array.from({ length: lines() * 2 },
      () => [Math.random() * 2 - 1, Math.random() * 2 - 1] as v2f
    ))
  )

  createEffect(() =>
    setChannels([
      {
        color: "gray",
        yOffset: 0, yScale: 1, data: {
          edges: grid
        }
      },
      {
        color: colors[0], yOffset: 0, yScale: scale(), data: {
          edges: lineData()
        }
      }
    ])
  );

  return <>
    <Graph bgColor="cornsilk" maxChannels={maxChannels} channels={channels()} />
    <div style="display: flex; flex-direction: row;">
      <input type="range" min={1} max={100} value={lines()} onInput={(e) => setLines(e.target.valueAsNumber)} />
      <p>Lines: {lines()}</p>
    </div>
    <div style="display: flex; flex-direction: row;">
      <input type="range" min={0} max={1000} value={scale() * 1000} onInput={(e) => setScale(e.target.valueAsNumber / 1000)} />
      <p>Scale: {scale()}</p>
    </div>
  </>;
};

const expect = <
  T extends { _type: string },
  K extends T['_type']
>(obj: T, type: K): Extract<T, { _type: K }> | null => (
  obj._type === type ? (obj as never) : null
)

const WebRTCPeers = () => {
  const [connection, setConnection] = createSignal<DummyConnection<string>>();
  createDummyConnection(setConnection);
  const [received, setReceived] = createSignal("");
  createEffect(() => {
    const conn = connection();
    if (conn._type === "connected") {
      conn.setOnMessageReceived(setReceived)
    } else {
      setReceived("")
    }
  })

  return <Switch
    fallback={<p>Connection state: {connection()._type}</p>}
  >
    <Match when={expect(connection(), "error")}>
      {(conn) => <p>Failed to stablish connection: {conn().reason}</p>}
    </Match>
    <Match when={expect(connection(), "closed")}>
      {(_) => <>
        <button onclick={() => createDummyConnection(setConnection)}>Connect</button>
        <p>Connection closed</p>
      </>}
    </Match>
    <Match when={expect(connection(), "connected")}>
      {(conn) => {
        let textInput: HTMLInputElement;
        return <div>
          <button onclick={(_) => {
            conn().close()
          }}>Close connection</button>
          <input type="text" ref={textInput}></input>
          <button onclick={(_) => {
            conn().sendMessage(textInput.value)
            textInput.value = ""
          }}>Send message</button>
          <p>Message received: {received()}</p>
        </div>
      }}
    </Match>
  </Switch>
}

const frameToLines = (frame: ScopeFrame, t: number = 0, tCoeff: number = 1): v2f[] => {
  const lines: v2f[] = new Array(frame.data.length)
  for (let i = 0; i < lines.length; i++) {
    const y = frame.data[i][1]
    const dt = frame.data[i][0]
    t = t + dt * tCoeff;
    lines[i] = [t - 1, y]
  }
  return lines
}

/**
 * Creates an interval that accepts a signal as the timeout argument
 * 
 * @param handler Timer handler
 * @param timeout Timeout accessor for signal
 */
const createInterval = (handler: TimerHandler, timeout: Accessor<number>,) => {
  let interval: number = null
  createEffect(() => {
    if (interval !== null) {
      clearInterval(interval)
    }
    interval = setInterval(handler, timeout())
  })
  onCleanup(() => {
    if (interval !== null) {
      clearInterval(interval)
    }
  })
}

const WebRTCLocalGraph = () => {
  const [connection, setConnection] = createSignal<
    DummyConnection<ArrayBuffer>
  >()
  const [latestFrame, setLatestFrame] = createSignal<ScopeFrame>()
  const [tScale, setTScale] = createSignal(20)
  const [yScale, setYScale] = createSignal(1)
  const [maxSamples, setMaxSamples] = createSignal(100000)
  const [yOff, setYOff] = createSignal(0)
  const [freq, setFreq] = createSignal(100)
  const [sampleRate, setSampleRate] = createSignal(1000)
  const [pointsPerF, setPointsPerF] = createSignal(100)
  const grid = buildGrid(6, 6)
  createDummyConnection(setConnection)

  function setLastFrameFromArrBuff(buff: ArrayBuffer) {
    setLatestFrame((prev) =>
      prev ? processFrame(
        prev,
        decodeScopeFrame(buff),
        maxSamples()
      ) : decodeScopeFrame(buff)
    )
  }

  createEffect(() => {
    const conn = connection()
    if (conn._type === "connected") {
      conn.setOnMessageReceived(setLastFrameFromArrBuff)
    } else {
      setLatestFrame()
    }
  })

  function createFrameData(): FrameData {
    const f = untrack(freq)
    const n = untrack(pointsPerF)
    const dt = 1 / untrack(sampleRate)
    const ts = Array.from({ length: n }, (_, i) => i * dt)
    return ts.map((t) => [dt, Math.sin(t * Math.PI * f)])
  }

  let latestSentFrameN: number = 0
  createInterval(() => {
    const conn = connection()
    if (conn._type === "connected") {
      conn.sendMessage(encodeScopeFrame({
        frameNumber: latestSentFrameN++,
        data: createFrameData()
      }))
    }
  }, () => pointsPerF() / sampleRate() * 1000)

  let gray = resolveColor("gray");
  let red = resolveColor("red");

  return <Show when={connection()._type === "connected"}>
    <>
      <p>Server side</p>
      <>
        <p>Sin Frequency: {freq()}</p>
        <FracRange bounds={[1, 100]} res={.01} sig={[freq, setFreq]} />
      </>
      <>
        <p>Sample Rate: {sampleRate()}</p>
        <FracRange bounds={[1, 10000]} sig={[sampleRate, setSampleRate]} />
      </>
      <>
        <p>Points per frame: {pointsPerF()}</p>
        <FracRange bounds={[1, 1000]} sig={[pointsPerF, setPointsPerF]} />
      </>
    </>
    <>
      <p>Client side</p>
      <Graph bgColor="cornsilk" maxChannels={2} channels={[
        {
          color: gray,
          yOffset: 0, yScale: 1, data: {
            edges: grid
          }
        },
        {
          color: red, yOffset: yOff(), yScale: yScale(), data: {
            linePoints: frameToLines(latestFrame(), 0, tScale())
          }
        }
      ]} />
      <>
        <p>Y Scale: {yScale()}</p>
        <FracRange bounds={[.1, 10]} res={.01} sig={[yScale, setYScale]} />
      </>
      <>
        <p>T Scale: {tScale()}</p>
        <FracRange bounds={[.1, 100]} res={.01} sig={[tScale, setTScale]} />
      </>
      <>
        <p>Y Offset: {yOff()}</p>
        <FracRange bounds={[-10, 10]} res={.01} sig={[yOff, setYOff]} />
      </>
    </>
  </Show>
}

const FracRange: Component<{ bounds: [min: number, max: number], res?: number, sig: Signal<number> }> = (props) => {
  const res = ("res" in props) ? props.res : 1
  return <input
    type="range"
    min={props.bounds[0] / res}
    max={props.bounds[1] / res}
    value={props.sig[0]() / res}
    onInput={(e) => props.sig[1](e.target.valueAsNumber * res)}
  />
}

const SocketIOTest = () => {
  const socket = io()
  const [connected, setConnected] = createSignal(false)
  const [latestData, setLatestData] = createSignal<string>(null)
  socket.on("connect", () => {
    setLatestData(null)
    setConnected(true)
  })
  socket.on("disconnect", reason => setConnected(false))
  socket.on("data_test", (data: string) => setLatestData(data))
  socket.onAny((...args) => console.log(`Got event ${args}`))
  return <Switch fallback={<p>Disconnected</p>}>
    <Match when={(latestData() !== null) && connected()}>
      <p>Latest data: {latestData()}</p>
    </Match>
    <Match when={connected()}>
      <p>Connected, waiting for data</p>
    </Match>
  </Switch>
}

type PromiseResult<Result, ErrT = any> = ADT<{
  awaiting: {}
  success: {
    result: Result
  }
  error: {
    reason: ErrT
  }
}>

const promiseSignal = <Result,>(prom: Promise<Result>) => {
  const [getResult, setResult] = createSignal<PromiseResult<Result>>({ _type: "awaiting" })
  prom.then(
    res => setResult({ _type: "success", result: res }),
    err => setResult({ _type: "error", reason: err })
  )
  return getResult
}

const WebRTCRemoteGraph = () => {
  const GraphThing: Component<{
    setOnMessageReceived: (handler: (m: ArrayBuffer) => void) => void
  }> = (props) => {
    const [tScale, setTScale] = createSignal(20)
    const [yScale, setYScale] = createSignal(1)
    const [yOff, setYOff] = createSignal(0)
    const [maxSamples, setMaxSamples] = createSignal(100000)
    const [latestFrame, setLatestFrame] = createSignal<ScopeFrame>({ frameNumber: 0, data: [] })
    const [lastFn, setLastFn] = createSignal(0)
    const [fps, setFps] = createSignal<number>()

    let latestSentFrameN: number = 0

    function setLastFrameFromArrBuff(buff: ArrayBuffer) {
      console.log("Recieved frame")
      setLatestFrame((prev) => {
        const frame = decodeScopeFrame(buff)
        latestSentFrameN = frame.frameNumber
        return prev ? processFrame(
          prev,
          frame,
          maxSamples()
        ) : frame
      })
    }

    createInterval(() => setLastFn((prev) => {
      const lastFrame = latestSentFrameN
      setFps(frameDifference(lastFrame, prev))
      return lastFrame
    }), () => 1000)

    props.setOnMessageReceived(setLastFrameFromArrBuff)

    const gray = resolveColor("gray");
    const red = resolveColor("red");
    const grid = buildGrid(6, 6)

    return <>
      <p>FPS: {fps()}</p>
      <Graph bgColor="cornsilk" maxChannels={2} channels={[
        {
          color: gray,
          yOffset: 0, yScale: 1, data: {
            edges: grid
          }
        },
        {
          color: red, yOffset: yOff(), yScale: yScale(), data: {
            linePoints: frameToLines(latestFrame(), 0, tScale())
          }
        }
      ]} />
      <>
        <p>Y Scale: {yScale()}</p>
        <FracRange bounds={[.1, 10]} res={.01} sig={[yScale, setYScale]} />
      </>
      <>
        <p>T Scale: {tScale()}</p>
        <FracRange bounds={[.1, 100]} res={.01} sig={[tScale, setTScale]} />
      </>
      <>
        <p>Y Offset: {yOff()}</p>
        <FracRange bounds={[-10, 10]} res={.01} sig={[yOff, setYOff]} />
      </>
      <>
        <p>Max stored samples: {maxSamples()}</p>
        <FracRange bounds={[1, 10000]} sig={[maxSamples, setMaxSamples]} />
      </>
    </>
  }

  const GeneratorThing: Component<{
    sendMessage: (m: ArrayBuffer) => void
  }> = (props) => {
    const [freq, setFreq] = createSignal(100)
    const [sampleRate, setSampleRate] = createSignal(1000)
    const [pointsPerF, setPointsPerF] = createSignal(100)
    const [lastFn, setLastFn] = createSignal(0)
    const [fps, setFps] = createSignal<number>()

    function createFrameData(): FrameData {
      const f = untrack(freq)
      const n = untrack(pointsPerF)
      const dt = 1 / untrack(sampleRate)
      const ts = Array.from({ length: n }, (_, i) => i * dt)
      return ts.map((t) => [dt, Math.sin(t * Math.PI * f)])
    }

    let latestSentFrameN: number = 0
    createInterval(() => {
      latestSentFrameN = nextFrame(latestSentFrameN)
      props.sendMessage(encodeScopeFrame({
        frameNumber: latestSentFrameN++,
        data: createFrameData()
      }))
    }, () => pointsPerF() / sampleRate() * 1000)

    createInterval(() => setLastFn((prev) => {
      const lastFrame = latestSentFrameN
      setFps(frameDifference(lastFrame, prev))
      return lastFrame
    }), () => 1000)

    return <>
      <>
        <p>Sin Frequency: {freq()}</p>
        <FracRange bounds={[1, 100]} res={.01} sig={[freq, setFreq]} />
      </>
      <>
        <p>Sample Rate: {sampleRate()}, FPS: {fps()}</p>
        <FracRange bounds={[1, 10000]} sig={[sampleRate, setSampleRate]} />
      </>
      <>
        <p>Points per frame: {pointsPerF()}</p>
        <FracRange bounds={[1, 1000]} sig={[pointsPerF, setPointsPerF]} />
      </>
    </>
  }

  const connection = promiseSignal(serverConnection("/connect"))
  const [dataChannel, setDataChannel] = createSignal<RTCChannel<never, ArrayBuffer>>({ _type: "opening" })
  const channelName = "webscope_data"
  createEffect(() => {
    const conn = connection()
    if (conn._type === "success") {
      createDataChannel(conn.result, channelName, setDataChannel, { maxRetransmits: 0, ordered: false })
    }
    if (conn._type === "error") {
      setDataChannel({ _type: "closed" })
    }
  })

  return <Switch>
    <Match when={connection()._type === "awaiting"}>
      <p>Establishing WebRTC connection</p>
    </Match>
    <Match when={expect(connection(), "error")}>
      {(connection) => <p>
        Failed to establish webrtc connection to server: {JSON.stringify(connection().reason)}
      </p>}
    </Match>
    <Match when={dataChannel()._type === "opening"}>
      <p>Opening data channel</p>
    </Match>
    <Match when={dataChannel()._type === "closed"}>
      <p>Data channel was closed</p>
    </Match>
    <Match when={expect(dataChannel(), "open")}>{
      (chan) => {
        return <>
          <>
            <p>Client side</p>
            <GraphThing setOnMessageReceived={chan().setOnMessageReceived} />
          </>
        </>
      }
    }</Match>
  </Switch>
}

const EchoTest = () => {
  const connection = promiseSignal(serverConnection("/connect"))
  const [dataChannel, setDataChannel] = createSignal<RTCChannel<string, string>>({ _type: "opening" })
  const [latestMessage, setLatestMessage] = createSignal<string>(null)
  createEffect(() => {
    const conn = connection()
    if (conn._type === "success") {
      createDataChannel(conn.result, "echo", setDataChannel)
    }
    if (conn._type === "error") {
      setDataChannel({ _type: "closed" })
    }
  })

  createEffect(() => {
    const chann = dataChannel()
    if (chann._type === "open") {
      chann.setOnMessageReceived(setLatestMessage)
    }
    else {
      setLatestMessage(null)
    }
  })

  return <Switch>
    <Match when={connection()._type === "awaiting"}>
      <p>Establishing WebRTC connection</p>
    </Match>
    <Match when={expect(connection(), "error")}>
      {(connection) => <p>Failed to establish webrtc connection to server: {JSON.stringify(connection().reason)}</p>}
    </Match>
    <Match when={dataChannel()._type === "opening"}>
      <p>Opening data channel</p>
    </Match>
    <Match when={dataChannel()._type === "closed"}>
      <p>Data channel was closed</p>
    </Match>
    <Match when={expect(dataChannel(), "open")}>{
      (chan) => {
        let textInput: HTMLInputElement;
        return <>
          <input type="text" ref={textInput}></input>
          <button onclick={(_) => {
            chan().sendMessage(textInput.value)
            textInput.value = ""
          }}>Send message</button>
          <Show when={latestMessage() !== null} fallback={<p>Waiting for message...</p>}>
            <p>Latest message recieved: {latestMessage()}</p>
          </Show>
        </>
      }
    }</Match>
  </Switch>
}

const App: Component = () => {
  return (
    <>
      <h1>Digital oscilloscope UI</h1>
      <EchoTest />
      <WebRTCRemoteGraph />
      <WebRTCLocalGraph />
      <GraphSinNoise />
    </>
  );
};

export default App;
