/**
 * Frames are encoded with a y value and a time delta, to graph
 * these it'll be necessary to integrate these deltas.
 */
export type FrameData = [y: number, tDelta: number][]

/**
 * A frame number is included to handle out of order and missing frames
 * when reconstructing the waveforms for time spans longer than a single packet
 */
export type ScopeFrame = {
    frameNumber: number
    data: FrameData,
}

/**
 * Decodes a frame from an array buffer received from webrtc
 * @param buff Array to decode from
 * @returns Decoded scope frame
 */
export const decodeScopeFrame = (buff: ArrayBuffer): ScopeFrame => {
    const metas = new Uint16Array(buff, 0, 1);
    const floats = new Float64Array(buff.slice(metas.byteLength))
    const data_arr = new Array(floats.length / 2) as FrameData
    for (let i = 0; i < data_arr.length; i++) {
        data_arr[i] = [floats[i * 2], floats[i * 2 + 1]]
    }
    return {
        frameNumber: metas[0],
        data: data_arr
    }
}

export const frameNumberBytes = Uint16Array.BYTES_PER_ELEMENT
const nofUniqueFrames = (2 ** 8) ** frameNumberBytes

/**
 * Efficiently concatenates two array buffers
 */
const appendBuffers = (buff1: ArrayBuffer, buff2: ArrayBuffer) => {
    const arr = new Uint8Array(buff1.byteLength + buff2.byteLength)
    arr.set(new Uint8Array(buff1), 0)
    arr.set(new Uint8Array(buff2), buff1.byteLength)
    return arr.buffer
}

/**
 * Encodes a frame to be sent as an array buffer via webrtc
 * @param frame Frame to be encoded
 */
export const encodeScopeFrame = (frame: ScopeFrame): ArrayBuffer => {
    const data = frame.data
    const data_arr = new Float64Array(data.length * 2)
    for (let i = 0; i < data.length; i++) {
        data_arr[i * 2] = data[i][0]
        data_arr[i * 2 + 1] = data[i][1]
    }
    const meta_arr = new Uint16Array(1);
    meta_arr[0] = frame.frameNumber
    return appendBuffers(meta_arr.buffer, data_arr.buffer)
}

/**
 * Computes distance between two numbers in a circular fashion, takes
 * care of overflows
 * @param current Current frame number
 * @param prev Previous frame number
 * @param span Number of unique symbols (n**2 for a number of n bits)
 * @returns Negative if frames are out of order
 */
const modDistance = (current: number, prev: number, span: number) =>
    (current - prev - span / 2) % span + span / 2

export const frameDifference = (current: number, prev: number) =>
    modDistance(current, prev, nofUniqueFrames)

export const nextFrame = (currentFrameN: number) => (currentFrameN + 1) % nofUniqueFrames

/**
 * Given a pair of frames, it produces a frame that either combines the
 * data from the two (when `maxSamples` allows) or chooses one of them,
 * resolving out of order or missing packets conflicts. Packets that exceed
 * the `maxSamples` are kept as is.
 * @param maxSamples Max samples when packets are concatenated
 */
export const processFrame = (prevFrame: ScopeFrame, frame: ScopeFrame, maxSamples: number): ScopeFrame => {
    const frameDiff = frameDifference(frame.frameNumber, prevFrame.frameNumber)
    if (frameDiff !== 1)
        return frameDiff > 0 ? frame : prevFrame
    if (frame.data.length >= maxSamples)
        return frame
    const rest = frame.data.length - maxSamples
    return {
        frameNumber: frame.frameNumber,
        data: prevFrame.data.slice(prevFrame.data.length - rest).concat(frame.data)
    }
}
