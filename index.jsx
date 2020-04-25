var React = require("react")
var ReactDOM = require("react-dom")
import Regl from "regl"
import mat4 from "gl-mat4"


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
    var pencilOnPaper = false
    var currentLine = []
    var handleTouch = (type, e) => {
      if (type == "start") {pencilOnPaper = true}
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
        const minDist = 1
        var lastPoint = currentLine[currentLine.length - 1] || [-minDist, -minDist]
        if (Math.abs(lastPoint[0] - x) > minDist || Math.abs(lastPoint[1]-y) > minDist) {
          currentLine.push([x, y])
        }
      } else {
        currentLine.length = 0 // clear & preserve ref
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
    console.log(canvasSpaceToGlSpace)

    const drawTriangle = regl({
      vert: `
        precision mediump float;
        attribute vec2 position;
        attribute vec2 positionNext;
        attribute float normalMultiplier;
        uniform mat4 projection;
        void main() {
          vec2 segmentDelta = positionNext - position;
          vec2 normal = normalize(vec2(-segmentDelta.y, segmentDelta.x));
          // vec2 normal = vec2(0.7, 0.7);
          const float width = 10.0;

          vec2 pointPosition = width * normal * normalMultiplier + position;

          gl_Position = projection * vec4(pointPosition, 0, 1);
        }`,

      frag: `
        precision mediump float;
        uniform vec4 color;
        void main() {
          gl_FragColor = color;
        }`,

      attributes: {
        position: () => {
          var buffer = regl.buffer({
            data: currentLine.concat(currentLine)
          })
          return buffer
        },
        positionNext: () => {
          var points = currentLine.concat(currentLine)
          if (points.length > 1) {
            points.push(points[points.length-2])
            points = points.slice(1, points.length)
          }
          var buffer = regl.buffer({
            data: points
          })
          return buffer
        },
        normalMultiplier: () => {
          var lefts = currentLine.map(x => -1)
          lefts[lefts.length - 1] = 1 // because of positionNext, last pt will have linedir flipped
          var rights = currentLine.map(x => 1)
          rights[rights.length - 1] = -1
          var buffer = regl.buffer({
            data: lefts.concat(rights)
          })
          return buffer
        }
      },

      uniforms: {
        projection: canvasSpaceToGlSpace,
        color: () => ([
          Math.cos(Date.now() * 0.001),
          Math.sin(Date.now() * 0.0008),
          Math.cos(Date.now() * 0.003),
          1
        ])
      },

      elements: () => {
        var elements = []
        for (var idx =0; idx<currentLine.length-1; idx++) {
          var tri1 = [idx, idx+currentLine.length + 1, idx+1]
          var tri2 = [idx+currentLine.length, idx+currentLine.length+1, idx]
          elements.push(tri1, tri2)
        }
        // console.log(elements)
        return elements
      },

      primitive: "triangles",
      // primitive: "line strip",
      // lineWidth: 1,
      // count: () => (currentLine.length-1)*6,
    })
    cleanupFunctions.push(regl.destroy)

    // Animation
    var tick = () => {
      var time = Date.now()
      regl.clear({
        color: [0, 0, 0, 0],
        depth: 1
      })
      // draw a triangle using the command defined above
      drawTriangle({
      })
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
