var React = require("react")
var ReactDOM = require("react-dom")
import Regl from "regl"
import mat4 from "gl-mat4"
import ndarray from "ndarray"
import ndops from "ndarray-ops"

var ndSlice = (ndarr, from, to) => {
  var lengths = to.map((t, idx) => from[idx] - t)
  return ndarr.lo(...from).hi(...lengths)
}

function LinesState (regl) {
  this.regl = regl
  var arrayLength = 1000 // length in number of points
  var points = ndarray(new Uint16Array(arrayLength*2), [arrayLength, 2])
  var widths = ndarray(new Uint16Array(arrayLength), [arrayLength])
  var normals = ndarray(new Int16Array(arrayLength*2), [arrayLength, 2])
  var lineIds = ndarray(new Uint16Array(arrayLength))
  var currentLineId = 0 // blank line
  var currentIdx = 0

  this.startNewLine = () => {
    currentLineId = 1
    currentIdx = 0
  }
  this.addPoint = ([x, y, width]) => {
    var [lastX, lastY] = [points.get(...[currentIdx-1], 0), points.get(...[currentIdx-1], 1)]
    var normal = [-(y - lastY), x - lastX]
    normals.set(...[currentIdx, 0], normal[0])
    normals.set(...[currentIdx, 1], normal[1])
    points.set(...[currentIdx, 0], x)
    points.set(...[currentIdx, 1], y)
    widths.set(...[currentIdx], width)
    lineIds.set(...[currentIdx], currentLineId)
    currentIdx += 1
  }

  var buffers = {}
  var bufferSet1 = {"point": points, "width": widths, "normal": normals, "lineId": lineIds}
  var bufferSet2 = {"normalMultiplier": null}
  Object.keys({...bufferSet1, ...bufferSet2}).forEach(name => {
    buffers[name] = this.regl.buffer()
  })

  var normalDirections = ndarray(new Int16Array(arrayLength * 2))
  ndops.assigns(ndSlice(normalDirections, [0], [arrayLength]), 1)
  ndops.assigns(ndSlice(normalDirections, [arrayLength], [arrayLength*2]), -1)
  buffers["normalMultiplier"]({
    data: Array.from(normalDirections.data), type: "int8"
  })

  this.elements = () => {
    var numPoints = currentIdx
    var elements = []
    if (numPoints < 2) {return ({elements})}
    var elements = new Uint16Array((numPoints - 1) * 2 * 3)
    for (var idx =0; idx<numPoints-1; idx++) {
      var tri1 = [idx, idx+arrayLength + 1, idx+1]
      elements.set(tri1, 6*idx)
      var tri2 = [idx+arrayLength, idx+arrayLength+1, idx]
      elements.set(tri2, 6*idx + 3)
    }
    return {elements}
  }

  this.attributes = () => {
    // updates the buffers
    Object.keys(bufferSet1).forEach(name => {
      //TODO: update buffers instead of creating new
      var typedArray = bufferSet1[name].data
      // need to double points for this line method. matches type of typedarray
      var doubledTypedArray = new typedArray.constructor(typedArray.length * 2)
      doubledTypedArray.set(typedArray, 0)
      doubledTypedArray.set(typedArray, typedArray.length)
      if (name == "normal") {
      }
      buffers[name]({
        data: doubledTypedArray
      })
    })
    return buffers
  }


}

var App = props => {
  var containerRef = React.useRef()

  React.useEffect(() => {
    var cleanupFunctions = []

    // Listener apparatus
    var listeners = []
    var addEventListener = (obj, eventName, func) => {
      listeners.push([obj, eventName, func])
      obj.addEventListener(eventName, func)
    }
    var cleanupListeners = () => {
      listeners.map(([obj, eventName, func]) => obj.removeEventListener(eventName, func))
    }
    cleanupFunctions.push(cleanupListeners)

    // Canvas
    var canvas = document.createElement('canvas')
    canvas.style.cssText = "height: 100%; width: 100%"
    containerRef.current.appendChild(canvas)
    var regl = Regl({canvas})
    var resizeCanvas = () => {
      const ratio = window.devicePixelRatio
      const { height, width} = canvas.getBoundingClientRect();
      canvas.height = height * ratio
      canvas.width = width * ratio
      regl.poll() //update viewport dims to canvas dims
    }
    resizeCanvas()
    addEventListener(window, "resize", resizeCanvas)

    // pencil & touch & click fallback
    var linesState = new LinesState(regl)
    var pencilOnPaper = false
    var currentLine = []
    var handleTouch = (type, e) => {
      if (type == "start") {
        pencilOnPaper = true
        linesState.startNewLine()
      }
      if (type == "end") {pencilOnPaper = false}

      e.preventDefault()

      var screenSpaceToCanvasSpace = ({pageX, pageY}) => {
        var canvasRect = canvas.getBoundingClientRect();
        var relX = pageX - canvasRect.left - window.pageXOffset
        var relY = pageY - canvasRect.top  - window.pageYOffset
        return [relX, relY]
      }
      var [x, y] = screenSpaceToCanvasSpace(e)

      if (pencilOnPaper) {
        // const minDist = 1
        // var lastPoint = currentLine[currentLine.length - 1] || [-minDist, -minDist]
        // if (Math.abs(lastPoint[0] - x) > minDist || Math.abs(lastPoint[1]-y) > minDist) {
          linesState.addPoint([x, y, 3])
        // }
      }
    }
    ;["touchstart", "mousedown"].forEach(name => addEventListener(canvas, name, e => handleTouch("start", e)))
    ;["touchmove", "mousemove"].forEach(name => addEventListener(canvas, name, e => handleTouch("move", e)))
    ;["touchend", "mouseup"].forEach(name => addEventListener(canvas, name, e => handleTouch("end", e)))

    // Projection matrix
    var canvasRect = canvas.getBoundingClientRect();
    var matrix = mat4.create()
    // order needs to be reversed
    mat4.scale(matrix, matrix, [2, -2, 1])
    mat4.translate(matrix, matrix, [-0.5, -0.5, 0])
    mat4.scale(matrix, matrix, [1/canvasRect.width, 1/canvasRect.height, 1])
    var canvasSpaceToGlSpace = matrix

    var attributeFunctions = {}
    Object.keys(linesState.attributes()).forEach(name => {
      attributeFunctions[name] = (context, props) => props[name]
    })

    const drawLines = regl({
      vert: `
        precision mediump float;
        attribute vec2 point;
        attribute vec2 normal;
        attribute float width;
        attribute float normalMultiplier;
        uniform mat4 projection;
        void main() {
          // vec2 normal = vec2(0.7, 0.7);
          vec2 normedNormal = normalize(normal);

          vec2 pointPosition = width * normedNormal * normalMultiplier + point;

          gl_Position = projection * vec4(pointPosition, 0, 1);
        }`,

      frag: `
        precision mediump float;
        uniform vec4 color;
        void main() {
          gl_FragColor = color;
        }`,

      uniforms: {
        projection: canvasSpaceToGlSpace,
        color: () => ([
          Math.cos(Date.now() * 0.001),
          Math.sin(Date.now() * 0.0008),
          Math.cos(Date.now() * 0.003),
          1
        ])
      },

      attributes: {
        ...attributeFunctions
      },

      elements: (context, props) => props.elements,

      primitive: "triangles",
    })
    cleanupFunctions.push(regl.destroy)

    // Animation
    var tick = () => {
      var time = Date.now()
      regl.clear({
        color: [0, 0, 0, 0],
        depth: 1
      })
      var props = {
        ...linesState.attributes(),
        ...linesState.elements(),
      }
      drawLines(props)
      animationFrameRequestId = window.requestAnimationFrame(tick)
    }
    var animationFrameRequestId = window.requestAnimationFrame(tick)
    var stopAnimation = () => window.cancelAnimationFrame(animationFrameRequestID)
    cleanupFunctions.push(stopAnimation)

    var cleanup = () => cleanupFunctions.forEach(f => f())
    return cleanup
  }, [])

  var html = <div style={{height: "100%", padding: "50px", boxSizing: "border-box"}}>
    <div ref={containerRef} style={{boxShadow: "0px 0px 3px #ccc",}}>
    </div>
  </div>

  return html
}

ReactDOM.render((
  <App/>
), document.getElementById('root'));
