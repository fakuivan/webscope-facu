import { ADT } from "ts-adt";
type MessageTypes = string | Blob | ArrayBuffer | ArrayBufferView

/**
 * Dummy loopback style connection, it does not route outside
 * the browser, but serves as an example of the basics needed
 * to establish a connection, and how messages are passed around.
 */
export type DummyConnection<M extends MessageTypes> = ADT<{
    connected: {
        sendMessage: (message: M) => void,
        setOnMessageReceived: (handler: (message: M) => void) => void
        close: () => void
    };
    closing: {};
    closed: {};
    connecting: {};
    error: { reason: string };
}>;

const makeRecord = <R extends Record<string, any>, T extends string>(
    data: Record<T, Omit<R, "_type">>
): R => {
    const [[type, properties]] = Object.entries(data)
    return { _type: (type as T), ...(properties as any) }
}

export const createDummyConnection = <M extends MessageTypes,>(setConnection: (c: DummyConnection<M>) => void) => {
    setConnection(makeRecord({ connecting: {} }))
    const localConn = new RTCPeerConnection();
    const localChan = localConn.createDataChannel("localChan");
    localChan.onclose = (e) => localConn.close();
    const remoteConn = new RTCPeerConnection();
    const error = (reason: string) => setConnection(makeRecord({ error: { reason } }));

    remoteConn.ondatachannel = ((e) => {
        const remoteChan = e.channel;
        remoteChan.onclose = (_) => {
            setConnection({ _type: "closing" });
            remoteConn.close();
            localChan.close();
            setConnection({ _type: "closed" });
        }
        remoteChan.onopen = (_) => {
            setConnection({
                _type: "connected",
                sendMessage: (message) => localChan.send(message as any),
                setOnMessageReceived: (handler) => {
                    remoteChan.onmessage = (e) => handler(e.data)
                },
                close: () => {
                    setConnection({ _type: "closing" });
                    remoteChan.close();
                    localChan.close();
                    setConnection({ _type: "closed" });
                }
            })
        }
    });

    localConn.onicecandidate = e => !e.candidate
        || remoteConn.addIceCandidate(e.candidate)
            .catch(() => error("Failed to add candidate to remote connection"));
    remoteConn.onicecandidate = e => !e.candidate
        || localConn.addIceCandidate(e.candidate)
            .catch(() => error("Failed to add ICE candidate to local connection"));
    localConn.createOffer()
        .then(offer => localConn.setLocalDescription(offer))
        .then(() => remoteConn.setRemoteDescription(localConn.localDescription))
        .then(() => remoteConn.createAnswer())
        .then(answer => remoteConn.setLocalDescription(answer))
        .then(() => localConn.setRemoteDescription(remoteConn.localDescription))
        .catch((err) => error("Failed to create offer: " + err.toString()));
}

export type RTCChannel<Send extends MessageTypes, Recv extends MessageTypes> = ADT<{
    open: {
        sendMessage: (message: Send) => void,
        setOnMessageReceived: (handler: (message: Recv) => void) => void
        close: () => void
    }
    opening: {}
    closed: {}
}>;

/**
 * Creates a connection to the backend using JSON HTTP API type signaling.
 * Essentially the session descriptions are passed around using the API
 * with a unique ID used for renegotiations, until a direct channel is
 * established.
 * @param path Path to the API endpoint to send and receive SDPs
 */
export const serverConnection = async (path: string): Promise<RTCPeerConnection> => {
    const connection = new RTCPeerConnection()

    await connection.setLocalDescription(await connection.createOffer())

    const postSdp = async (id: string = null) => {
        console.log(JSON.stringify(connection.localDescription.toJSON()))
        const response = await fetch(path, {
            method: "post",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...connection.localDescription.toJSON(),
                ...(id === null ? {} : { id: id })
            })
        })
        if (!response.ok) {
            throw Error("Failed to get session description from server")
        }
        const remoteOffer = await response.json()
        console.log(JSON.stringify(remoteOffer))
        return [new RTCSessionDescription(remoteOffer), remoteOffer.id] as const
    }

    const [remoteDesc, id] = await postSdp()
    await connection.setRemoteDescription(remoteDesc)

    connection.addEventListener("negotiationneeded", async (e) => {
        await connection.setLocalDescription(await connection.createOffer())
        const [remoteDesc, _] = await postSdp(id)
        await connection.setRemoteDescription(remoteDesc)
    })

    return connection
}

export const createDataChannel = <Send extends MessageTypes, Recv extends MessageTypes>(
    connection: RTCPeerConnection,
    label: string,
    setChannel: (c: RTCChannel<Send, Recv>) => void,
    options: RTCDataChannelInit = {}
) => {
    setChannel({ _type: "opening" })
    const channel = connection.createDataChannel(label, options)
    channel.onclose = (_) => {
        setChannel({ _type: "closed" });
    }
    const onChannelOpen = (_) => {
        setChannel({
            _type: "open",
            sendMessage: (message) => channel.send(message as any),
            setOnMessageReceived: (handler) => {
                channel.onmessage = (e) => handler(e.data)
            },
            close: () => {
                channel.close()
            }
        })
    }
    channel.onopen = onChannelOpen
    if (channel.readyState === "open") {
        onChannelOpen(null)
    }
}
