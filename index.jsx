var React = require("react")
var ReactDOM = require("react-dom")
import Regl from "regl"
import mat4 from "gl-mat4"
import ndarray from "ndarray"
import ndops from "ndarray-ops"
import Bezier from "bezier-js"

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
  var colors = ndarray(new Uint8Array(arrayLength*4), [arrayLength, 4])
  var lineBreaks = {}
  var lastLineBreak = 0
  var currentIdx = 0
  var currentLineNoninterpBuffer = [] // non-interpolated points (i.e. actual input) for current line

  this.startNewLine = () => {
    lineBreaks[currentIdx] = true
    lastLineBreak = currentIdx
    currentLineNoninterpBuffer = []
    // currentIdx is where the next point is going to be -- doesn't exist yet
  }
  var pointAtIndex = idx => ({x: points.get(...[idx], 0), y: points.get(...[idx], 1)})
  this.addPoint = ({p ,width,normal}) => {
    var l2Distance = (p1, p2) => Math.sqrt((p1.x-p2.x)**2 + (p1.y-p2.y)**2)

    var numPointsInLine = currentLineNoninterpBuffer.length

    var color = [0,0,0,255]
    var randColor = () => [...[1,1,1].map(x => Math.floor(Math.random()*255)), 255]
    var distanceFromLastPoint = l2Distance(p, pointAtIndex(currentIdx - 1))

    if (distanceFromLastPoint <= 1) {
      return
    } else if (distanceFromLastPoint > 10 && numPointsInLine >= 3) {
      var lastTwoPoints = [2,1].map(d => currentLineNoninterpBuffer[numPointsInLine - d])
      var bezier = Bezier.quadraticFromPoints(...lastTwoPoints, p, 0.5)
      var subCurve = bezier.split(0.5, 1)
      var curveLength = bezier.length()
      var curveLUT = subCurve.getLUT(Math.floor(curveLength / 10))
      curveLUT.slice(1, curveLUT.length - 1).forEach(p => {
        this.addPointToSet({p ,width, normal, color})
        // this.addPointToSet({p ,width, normal, color: randColor()})
      })
      this.addPointToSet({p ,width,normal, color})

    } else {
      this.addPointToSet({p ,width,normal, color})
    }

    currentLineNoninterpBuffer.push(p)
  }

  this.addPointToSet = ({p, width, normal, color}) => {
    var lastPoint = pointAtIndex(currentIdx - 1)
    normal = normal || [-(p.y - lastPoint.y), p.x - lastPoint.x]
    normals.set(...[currentIdx, 0], normal[0])
    normals.set(...[currentIdx, 1], normal[1])

    points.set(...[currentIdx, 0], p.x)
    points.set(...[currentIdx, 1], p.y)

    colors.set(...[currentIdx, 0], color[0])
    colors.set(...[currentIdx, 1], color[1])
    colors.set(...[currentIdx, 2], color[2])
    colors.set(...[currentIdx, 3], color[3])

    widths.set(...[currentIdx], width)
    currentIdx += 1
  }

  var buffers = {}
  var bufferSet1 = {"point": points, "width": widths, "normal": normals, "color": colors}
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
  var [pos, setPos] = React.useState(0)

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
    // var ratio = window.devicePixelRatio
    // canvas.style.cssText = `height: ${screen.width*ratio}px; width: ${screen.height*ratio}px`
    containerRef.current.appendChild(canvas)
    var regl = Regl({canvas})
    var resizeCanvas = () => {
      const ratio = 1//window.devicePixelRatio
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
        //TODO: initial-scale has to be 0.5 to get touch accuracy. But safari page size with
        // that isn't correct. SO use other checks to get canvas to right size.
        var relX = pageX - canvasRect.left - window.pageXOffset
        var relY = pageY - canvasRect.top  - window.pageYOffset
        return {x: relX, y: relY}
      }
      var {x, y} = screenSpaceToCanvasSpace(e)
      setPos(e && e.touches && e.touches[0].pageX)

      // Handle when pencil / touch leaves canvas.
      var canvasSize = canvas.getBoundingClientRect();
      if (x >= canvasSize.width || x < 0 || y >= canvasSize.height || y < 0) {
        linesState.startNewLine()
        return
      }
      ;["mouseleave"].forEach(name => addEventListener(canvas, name, e => linesState.startNewLine()))

      if (pencilOnPaper) {
        var width = 1
        var normal
        if (e.touches && e.touches[0]) {
          var touch = e.touches[0]
          // width = Math.cos(touch.altitudeAngle) * 10 + 2
          // normal = [10*Math.cos(touch.azimuthAngle), 10*Math.sin(touch.azimuthAngle)]
        }
        linesState.addPoint({p: {x, y}, width, normal})
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
        attribute vec4 color;
        varying vec4 colorOut;
        void main() {
          colorOut = color;
          vec2 normedNormal = normalize(normal);
          vec2 pointPosition = width * normedNormal * normalMultiplier + point;

          gl_Position = projection * vec4(pointPosition, 0, 1);
        }`,

      frag: `
        precision mediump float;
        varying vec4 colorOut;
        void main() {
          gl_FragColor = colorOut / 255.0;
        }`,

      uniforms: {
        projection: canvasSpaceToGlSpace,
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
    <div>
      {window.innerWidth}
      {"| |" + pos}
    </div>
    <div ref={containerRef} style={{boxShadow: "0px 0px 3px #ccc",}}>
    </div>
  </div>

  return html
}

ReactDOM.render((
  <App/>
), document.getElementById('root'));
