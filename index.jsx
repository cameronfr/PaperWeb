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
  var arrayLength = 10000 // length in number of points
  var points = ndarray(new Uint16Array(arrayLength*2), [arrayLength, 2])
  var widths = ndarray(new Uint16Array(arrayLength), [arrayLength])
  var normals = ndarray(new Int16Array(arrayLength*2), [arrayLength, 2])
  var lineBreaks = {}
  var currentIdx = 0

  this.startNewLine = () => {
    lineBreaks[currentIdx] = true
    // currentIdx = 0
  }
  this.addPoint = ([x,y,width,normal]) => {
    var pointAtIndex = idx => ([points.get(...[idx-1], 0), points.get(...[idx-1], 1)])
    var l2Distance = (p1, p2) => Math.sqrt((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2)
    var quadraticCurve = (p1, p2, p3) => {
      console.log(p1, p2, p3)
      var [x1, y1] = p1
      var [x2, y2] = p2
      var [x3, y3] = p3
      var denom = (x1-x2) * (x1-x3) * (x2-x3)
      var A = (x3 * (y2-y1) + x2 * (y1-y3) + x1 * (y3-y2)) / denom
      var B = (x3**2 * (y1-y2) + x2**2 * (y3-y1) + x1**2 * (y2-y3)) / denom
      var C = (x2 * x3 * (x2-x3) * y1 + x3 * x1 * (x3-x1) * y2 + x1 * x2 * (x1-x2) * y3) / denom
      return [A, B, C]
    }

    if (l2Distance([x,y], pointAtIndex(currentIdx)) > 10) {
      var lastPoint = pointAtIndex(currentIdx)
      // var [A, B, C] = quadraticCurve(pointAtIndex(currentIdx-1), lastPoint, [x,y])
      // var newPointX = lastPoint[0] + (x - lastPoint[0])/2
      // var newPointY = A * newPointX**2 + B * newPointX + C
      // console.log(A, B, C)
      // console.log(newPointX)
      // console.log(newPointY)
      // this.addPointToSet([newPointX,newPointY,width,normal])
      this.addPointToSet([x,y,width,normal])
    } else {
      this.addPointToSet([x,y,width,normal])
    }

  }

  this.addPointToSet = ([x, y, width, normal]) => {
    var [lastX, lastY] = [points.get(...[currentIdx-1], 0), points.get(...[currentIdx-1], 1)]
    normal = normal || [-(y - lastY), x - lastX]
    normals.set(...[currentIdx, 0], normal[0])
    normals.set(...[currentIdx, 1], normal[1])
    points.set(...[currentIdx, 0], x)
    points.set(...[currentIdx, 1], y)
    widths.set(...[currentIdx], width)
    currentIdx += 1
  }

  var buffers = {}
  var bufferSet1 = {"point": points, "width": widths, "normal": normals}
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
      if (idx+1 in lineBreaks) {continue}
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

      var canvasSize = canvas.getBoundingClientRect();
      if (x >= canvasSize.width || x < 0 || y >= canvasSize.height || y < 0) {pencilOnPaper = false}

      if (pencilOnPaper) {
        // const minDist = 1
        // var lastPoint = currentLine[currentLine.length - 1] || [-minDist, -minDist]
        // if (Math.abs(lastPoint[0] - x) > minDist || Math.abs(lastPoint[1]-y) > minDist) {
        var width = 1
        var normal
        if (e.touches && e.touches[0]) {
          var touch = e.touches[0]
          // width = Math.cos(touch.altitudeAngle) * 10 + 2
          normal = [10*Math.cos(touch.azimuthAngle), 10*Math.sin(touch.azimuthAngle)]
        }
        linesState.addPoint([x, y, width, normal])
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
        color: () => ([0,0,0,1])
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
