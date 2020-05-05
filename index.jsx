var React = require("react")
var ReactDOM = require("react-dom")
import Regl from "regl"
import mat4 from "gl-mat4"
import ndarray from "ndarray"
import ndops from "ndarray-ops"
import Bezier from "bezier-js"
import Stats from "stats.js"

var ndSlice = (ndarr, from, to) => {
  var lengths = to.map((t, idx) => from[idx] - t)
  return ndarr.lo(...from).hi(...lengths)
}

function syncedBuffer({arrayType, bufferType, shape, doubleTheBuffer, useElements, regl}) {
  // doubleTheBuffer: if the cpu typedArray is [1,2,3, ..., n], the buffer will be [1,2,3,...,n,1,2,3,...,n]

  var prod = arr => arr.reduce((a, b) => a*b, 1)

  var typedArray = new arrayType(prod(shape))
  var reglType = useElements ? regl.elements : regl.buffer
  var initialBufferValues = new arrayType(prod(shape) * (doubleTheBuffer ? 2 : 1))
  // Was getting weird behavior when setting length:arr.length * arr.BYTES_PER_ELEMENT and type: manual type instead of data: arr
  var buffer = reglType({
    data: initialBufferValues,
    usage: "dynamic"
  })

  this.shape = shape
  this.typedArray = typedArray
  this.buffer = buffer

  var offsets = shape.map((dimSize, dim) => {
    var subDims = shape.slice(dim+1, shape.length)
    var itemsInSubDims = prod(subDims)
    return itemsInSubDims
  })

  var getLocationForIndexes = indexes => {
    var location = 0
    indexes.forEach((i, dim) => {
      i >= shape[dim] && console.log(`Invalid index ${i} at dim ${dim}, shape is ${shape}`)
      location += i * offsets[dim]
    })
    return location
  }

  this.set = (indexes, value) => {
    var location = getLocationForIndexes(indexes)
    typedArray[location] = value
    buffer.subdata([value], (location) * typedArray.BYTES_PER_ELEMENT)
    if (doubleTheBuffer) {
      buffer.subdata([value], (location + typedArray.length) * typedArray.BYTES_PER_ELEMENT)
    }
  }

  this.get = (indexes) => {
    var location = getLocationForIndexes(indexes)
    var value = typedArray[location]
    return value
  }

}


function LinesState ({regl, setStats}) {
  this.regl = regl
  var arrayLength = 100000// length in number of points.
  //TODO: both ipad and mac glitches out when get to 25,000 points when limit is 40,000 -- should be issue with element buffers being uint16, and uint16 max val is 65535

  var points = new syncedBuffer({arrayType: Float32Array, shape: [arrayLength, 2], doubleTheBuffer: true, regl: this.regl})
  var widths = new syncedBuffer({arrayType: Uint16Array, shape: [arrayLength], doubleTheBuffer: true, regl: this.regl})
  var normals = new syncedBuffer({arrayType: Float32Array, shape: [arrayLength, 2], doubleTheBuffer: true, regl: this.regl})
  var colors = new syncedBuffer({arrayType: Uint8Array, shape: [arrayLength, 4], doubleTheBuffer: true, regl: this.regl})
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
  var pointAtIndex = idx => ({x: points.get([idx, 0]), y: points.get([idx, 1])})
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
      // this.addPointToSet({p:subCurve.get(0.5) ,width, normal, color: [255, 0, 0, 255]})
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
    setStats({numPoints: currentIdx})
    var lastPoint = pointAtIndex(currentIdx - 1)
    normal = normal || [-(p.y - lastPoint.y), p.x - lastPoint.x]
    normals.set([currentIdx, 0], normal[0])
    normals.set([currentIdx, 1], normal[1])

    points.set([currentIdx, 0], p.x)
    points.set([currentIdx, 1], p.y)

    colors.set([currentIdx, 0], color[0])
    colors.set([currentIdx, 1], color[1])
    colors.set([currentIdx, 2], color[2])
    colors.set([currentIdx, 3], color[3])


    if (currentIdx == lastLineBreak) {
      width = 0
    }

    widths.set([currentIdx], width)
    updateElements(currentIdx, currentIdx == lastLineBreak)

    currentIdx += 1
  }

  var normalMultipliers = new syncedBuffer({arrayType: Int16Array, shape: [arrayLength*2], doubleTheBuffer: false, regl: this.regl})
  for (var i = 0; i < arrayLength; i++) {
    normalMultipliers.set([i], 1)
  }
  for (var i = arrayLength; i < arrayLength*2; i++) {
    normalMultipliers.set([i], -1)
  }

  var bufferList = {points, widths, normals, colors, normalMultipliers}
  var bufferDict = {}
  Object.keys(bufferList).forEach(key => {
    var bufferName = key
    if (bufferName[bufferName.length - 1] == "s") {
      bufferName = bufferName.slice(0, bufferName.length - 1)
    }
    bufferDict[bufferName] = bufferList[key].buffer
  })

  var elements = new syncedBuffer({arrayType: Uint32Array, shape: [arrayLength*6], doubleTheBuffer: false, useElements: true, regl: this.regl})
  var updateElements = (pointIdx, isNewLineStart) => {
    if (pointIdx < 1 || isNewLineStart) {
      return
    }
    var tri1 = [pointIdx -1, pointIdx + arrayLength, pointIdx]
    var tri2 = [pointIdx - 1 + arrayLength, pointIdx + arrayLength , pointIdx - 1]
    var tris = [...tri1, ...tri2]
    tris.forEach((vertexIdx, i) => {
      elements.set([(pointIdx-1)*tris.length+i], tris[i])
    })
  }

  this.elements = () => ({elements: elements.buffer})
  this.count = () => ({count: Math.max(0, currentIdx - 1) * 2 * 3})

  this.attributes = () => {
    return bufferDict
  }
}

function CanvasManager({canvas, linesState, regl, onNewPoint}) {
  this.onNewPoint = onNewPoint

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
  var handleTouch = (type, e) => {
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

    // Handle when pencil / touch leaves canvas.
    var canvasSize = canvas.getBoundingClientRect();
    if (x >= canvasSize.width || x < 0 || y >= canvasSize.height || y < 0) {
      linesState.startNewLine()
      return
    }
    ;["mouseleave"].forEach(name => addEventListener(canvas, name, e => linesState.startNewLine()))

    if (e.touches && e.touches[0]) {
      var touch = e.touches[0]
      var {azimuthAngle, altitudeAngle} = touch
    }

    this.onNewPoint({type, p: {x, y}, azimuthAngle, altitudeAngle})
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
    count: (context, props) => props.count,
    primitive: "triangles",
  })

  var stats = new Stats();
  stats.showPanel(0);
  canvas.parentNode.appendChild(stats.dom)

  // Animation
  var tick = () => {
    stats.begin()
    var time = Date.now()
    regl.clear({
      color: [0, 0, 0, 0],
      depth: 1
    })
    var props = {
      ...linesState.attributes(),
      ...linesState.elements(),
      ...linesState.count(),
    }
    drawLines(props)
    animationFrameRequestId = window.requestAnimationFrame(tick)
    stats.end()
  }
  var animationFrameRequestId = window.requestAnimationFrame(tick)
  var stopAnimation = () => window.cancelAnimationFrame(animationFrameRequestID)
  cleanupFunctions.push(stopAnimation)

  this.cleanup = () => cleanupFunctions.forEach(f => f())
}

var App = props => {
  var containerRef = React.useRef()
  var [stats, setStats] = React.useState({})

  var [linesState, setLinesState] = React.useState()
  var [regl, setRegl] = React.useState()
  var [canvasManager, setCanvasManager] = React.useState()

  React.useEffect(() => {
    var canvas = document.createElement('canvas')
    canvas.style.cssText = "height: 100%; width: 100%"
    containerRef.current.appendChild(canvas)

    var regl = Regl({canvas, extensions: ["OES_element_index_uint"]})
    setRegl({regl})
    var linesState = new LinesState({regl, setStats})
    setLinesState(linesState)
    var canvasManager = new CanvasManager({linesState, regl, canvas, onNewPoint: () => null})
    setCanvasManager(canvasManager)
  }, [])

  React.useEffect(() => {
    var pencilOnPaper = false
    var onNewPoint = ({type, p, altitudeAngle, azimuthAngle}) => {
      if (type == "start") {
        pencilOnPaper = true
        linesState.startNewLine()
      }
      if (type == "end") {pencilOnPaper = false}

      if (pencilOnPaper) {
        var width = 2
        var normal
        if (altitudeAngle && azimuthAngle) {
          // width = Math.cos(touch.altitudeAngle) * 10 + 2
          // normal = [10*Math.cos(touch.azimuthAngle), 10*Math.sin(touch.azimuthAngle)]
        }
        linesState.addPoint({p, width, normal})
      }
    }
    if(canvasManager) {
      canvasManager.onNewPoint = onNewPoint
    }
  }, [canvasManager, linesState])

  // if render this component at 60fps, get noticeable slowdown
  var html = <>
    <div style={{height: "100%", padding: "50px", boxSizing: "border-box"}}>
      <div>
        {window.innerWidth}
        {"| |" + Math.floor(stats.numPoints / 100) }
      </div>
      <div ref={containerRef} style={{boxShadow: "0px 0px 3px #ccc",}}>
      </div>
    </div>
  </>

  return html
}

var ControlPanel = props => {
  var colors = ["#000000", "#ff0000", "#00ff00"]
  var [currentColor, setCurrentColor] = React.useState(colors[0])

  colorList = colors.map(color => {
    return <>
      <div style={{backgroundColor: color, width: "20px", height: "20px", borderRadius: "5px"}}>

      </div>
    </>
  })

  var html = <>
    <div style={{display: "grid", gridTemplateColumns: "auto", padding: "10px", boxShadow: "0px 0px 3px #ccc"}}>
      colorList
    </div>
  </>

}

function hexToRGB(h) {
  return [+("0x"+h[1]+h[2]), +("0x"+h[3]+h[4]), +("0x"+h[5]+h[6])]
}

ReactDOM.render((
  <App/>
), document.getElementById('root'));
