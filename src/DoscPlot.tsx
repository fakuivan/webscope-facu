import { Component, createEffect, createSignal, onCleanup } from "solid-js";

type GlCtx = WebGL2RenderingContext | WebGLRenderingContext;
export type v2f = [x: number, y: number];
export type RGBA = [r: number, g: number, b: number, a: number];
export type ScOff = [yScale: number, yOffset: number]

export type PlotChannel = {
  color: RGBA | string
  yScale?: number
  yOffset?: number
  data: { linePoints: v2f[] } | { edges: v2f[] }
}

function compileShader(gl: GlCtx, type: number, src: string): WebGLShader | string {
  let shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return gl.getShaderInfoLog(shader);
  }
  return shader
}

/**
 * Same as `flattenChannelsSlow` but with explicit loops so that it runs
 * fast on jitted interpreters like v8
 */
function flattenChannels(channels: v2f[][]): number[] {
  let vertices = Array<number>(
    channels.reduce((prev, chan) => (chan.length + prev), 0) * 3
  );
  let vert_n = 0
  for (let channel_n = 0; channel_n < channels.length; channel_n++) {
    const channel = channels[channel_n];
    for (let i = 0; i < channel.length; i++) {
      vertices[vert_n] = channel[i][0];
      vertices[vert_n + 1] = channel[i][1];
      vertices[vert_n + 2] = channel_n;
      vert_n += 3;
    }
  }
  return vertices;
}

/**
 * Channel numbers are identified by the index position of each array
 * of points in the channels array
 * 
 * @param channels array of arrays of 2D points
 * @returns 3D points where the last number indicates channel number
 */
function flattenChannelsSlow(channels: v2f[][]): number[] {
  return channels.flatMap(
    (chan, chan_number) => chan.flatMap((point) => [...point, chan_number])
  )
}

/**
 * Turns a list of connected points into a flat list of vertices
 * 
 * @param points connected points
 * @returns vertices
 */
function connectedLines(points: v2f[]) {
  if (points.length === 0) {
    return []
  }
  let lines = Array<v2f>((points.length - 1) * 2);
  for (let point_n = 0; point_n < points.length - 1; point_n++) {
    let line_n = point_n * 2;
    lines[line_n] = points[point_n];
    lines[line_n + 1] = points[point_n + 1];
  }
  return lines
}

/**
 * Builds a graph inside a given gl context. This context usually comes from
 * the canvas where you want to draw the graph. A maximum number of channels is
 * set when built, this number is fixed due to how the shaders are compiled.
 * 
 * @param gl Context to build the graph with
 * @param maxChannels Set the max number of channels to be supported in this graph
 * @returns Pair of functions to set the background colors and the contents
 *          of the graph. The function to set the contents of the graph then
 *          returns a function to actually draw the graph. This draw function
 *          can be called repeatedly as long as the contents don't change.
 */
function buildGraph(gl: GlCtx, maxChannels: number) {
  const glslVer: string = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
  const ver: 2 | 3 = glslVer.startsWith("WebGL GLSL ES 3.00") ? 3 :
    glslVer.startsWith("WebGL GLSL ES 2.00") ? 2 :
      undefined
  if (ver === undefined) {
    throw Error(`Unrecognized OpenGL GLSL version: ${glslVer}`)
  }

  const fragShaderSrc = ver === 3 ? `
    #version 300 es
    precision mediump float;
    in vec4 v_colour;
    out vec4 o_colour;
    void main() {
      o_colour = v_colour;
    }
    ` : `
    precision mediump float;
    varying vec4 v_colour;
    void main(void) {
      gl_FragColor = v_colour;
    }
    `

  const vertexShaderSrc = (ver === 3 ? `
    #version 300 es
    in vec3 a_coords;
    out vec4 v_colour;
    ` : `
    attribute vec3 a_coords;
    varying vec4 v_colour;
    `) + `
    #define MAX_CHANS ${maxChannels}
    uniform vec4 u_colours[MAX_CHANS];
    uniform vec2 u_scales_and_offsets[MAX_CHANS];
    vec2 scoff;
    void main(void) {
      int zint = int(a_coords.z);
      scoff = u_scales_and_offsets[zint];
      gl_Position = vec4(a_coords.x, a_coords.y*scoff.x + scoff.y, 0, 1);
      v_colour = u_colours[zint];
    }
  `
  let vertexBuffer = gl.createBuffer();
  //gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  const fragShader = compileShader(gl, gl.FRAGMENT_SHADER, fragShaderSrc.trim());
  if (typeof fragShader == "string") {
    throw Error("Failed to compile fragment shaders: " + fragShader);
  }
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSrc.trim());
  if (typeof vertexShader == "string") {
    throw Error("Failed to compile vertex shaders" + vertexShader);
  }
  let program = gl.createProgram();
  gl.attachShader(program, fragShader);
  gl.attachShader(program, vertexShader);
  gl.linkProgram(program);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  let refCoord = gl.getAttribLocation(program, "a_coords");
  gl.vertexAttribPointer(refCoord, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(refCoord);
  let refColors = gl.getUniformLocation(program, "u_colours");
  let refScOffs = gl.getUniformLocation(program, "u_scales_and_offsets");

  const setBgColor = (bgColor: RGBA) => {
    gl.clearColor(...bgColor);
  }

  const setChannels = (channels: PlotChannel[]) => {
    if (channels.length > maxChannels) {
      throw Error(`Number of channels (${channels.length}) exceeds  max for plot (${maxChannels})`);
    }
    let colors: RGBA[] = []
    let channelsData: v2f[][] = []
    let scOffs: ScOff[] = []

    for (let ch_n = 0; ch_n < channels.length; ch_n++) {
      const channel = { yScale: 1, yOffset: 0, ...channels[ch_n] };

      const data = channel.data;
      channelsData.push("edges" in data ? data.edges : connectedLines(data.linePoints))
      colors.push(resolveColor(channel.color))
      scOffs.push([channel.yScale, channel.yOffset])
    }
    const lineBuffer = flattenChannels(channelsData);

    gl.uniform4fv(refColors, new Float32Array(colors.flat()));
    gl.uniform2fv(refScOffs, new Float32Array(scOffs.flat()));
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineBuffer), gl.STATIC_DRAW);
    return () => {
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.LINES, 0, lineBuffer.length / 3);
    }
  }
  return { setChannels, setBgColor }
}

// pretty slow, as it needs to add a new canvas to the DOM, use sparingly
export function htmlColor(colorName: string): number {
  var ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = colorName;
  return parseInt(ctx.fillStyle.slice(1), 16);
}

export function intColorToRgba(color: number, alpha: number = 1.): RGBA {
  return [
    (color >> 16 & 255) / 255.0,
    (color >> 8 & 255) / 255.0,
    (color & 255) / 255.0,
    alpha
  ];
}

export const resolveColor = (color: RGBA | string): RGBA =>
  !Array.isArray(color) ? intColorToRgba(htmlColor(color)) : color


/**
 * Builds a 2D grid between -1 and 1 with `ny` and `nx` subdivisions.
 * 
 * @param nx subdivisions in the x axis
 * @param ny subdivisions in the y axis
 * @returns Flat list of pairs of points to for each line in the grid
 */
export function buildGrid(nx: number, ny: number): v2f[] {
  const uniform = (n: number) => Array.from({ length: n + 1 }, (_, i: number) => (i * 2 / n) - 1);
  const xg: v2f[] = uniform(nx).flatMap((x) => [[x, -1], [x, 1]]);
  const yg: v2f[] = uniform(ny).flatMap((y) => [[-1, y], [1, y]]);
  return [xg, yg].flat();
}

/**
 * Creates an oscilloscope-like graph component using a WebGL, updates to the
 * `channels` or `bgColor` prop trigger a redraw on the canvas.
 * Changing `maxChannels` causes a rebuild of the graph.
 */
export const Graph: Component<{ channels: PlotChannel[], bgColor: string | RGBA, maxChannels: number }> = (props) => {
  let canvas: HTMLCanvasElement
  let [graph, setGraph] = createSignal<ReturnType<typeof buildGraph>>()

  createEffect(() => {
    // TODO: test if the browser handles the webgl app going out of scope, or if
    // it'd be necessary to remove the app before rebuilding the graph.
    const gl = canvas.getContext("webgl2");
    setGraph(buildGraph(gl, props.maxChannels));
  })

  createEffect(() => {
    graph().setBgColor(resolveColor(props.bgColor));
    const draw = graph().setChannels(props.channels);

    const frame = window.requestAnimationFrame(draw);
    onCleanup(() => window.cancelAnimationFrame(frame));
  })

  return <canvas ref={canvas} />
}

export default Graph;
