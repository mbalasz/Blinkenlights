/*
 * @license
 * Getting Started with Web Serial Codelab (https://todo)
 * Copyright 2019 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */
'use strict';

import "regenerator-runtime/runtime";
import { parseGIF, decompressFrames } from "gifuct-js";
import { Dropzone } from "dropzone";

const css = require("./style.css");

let port;
let reader;
let inputDone;
let outputDone;
let inputStream;
let outputStream;
let gammaTable;
let currentImage;

const COLS = 16;
const ROWS = COLS;

const MIN_GAMMA = 0.5;
const MAX_GAMMA = 3.0;
const DEFAULT_GAMMA = 2.0;

const log = document.getElementById('log');
const butConnect = document.getElementById('butConnect');
const butSend = document.getElementById('butSend');
const commandTextInput = document.getElementById('commandTxt');
const pixelArtContainer = document.getElementById('pixelArtContainer');
const gammaSlider = document.getElementById('gammaSlider');
const gammaDisplay = document.getElementById('gammaDisplay');
const debugButton = document.getElementById('debugButton');
const clockButton = document.getElementById('clockButton');
const gifDropzone = document.getElementById('gif-dropzone');

Dropzone.options.gifDropzone = {
    autoProcessQueue: false,
    autoQueue: false,
    createImageThumbnails: false,
    accept: function (file, done) {
	var fr = new FileReader();
        fr.onload = function () {
	    var img = document.createElement('img');
            img.src = fr.result;

	    var oReq = new XMLHttpRequest();
	    oReq.open('GET', img.src, true);
	    oReq.responseType = 'arraybuffer';
	    oReq.onload = function(oEvent) {
		var arrayBuffer = oReq.response;
		if (arrayBuffer) {
		    var gif = parseGIF(arrayBuffer);
		    if (gif.lsd.width != ROWS || gif.lsd.height != COLS) {
			console.log(file.name + ": only " + ROWS + "x" + COLS + " GIF supported");
			return;
		    }
		    img.className = "pixelArt";
		    initPixelArtImage(img);
		    pixelArtContainer.appendChild(img);
		}
	    }
	    oReq.send(null)
        }
        fr.readAsDataURL(file);
	Dropzone.forElement('#gif-dropzone').removeFile(file);
	done();
    },
    init: function () {
	console.log("Dropzone init!")
    }
}

document.addEventListener('DOMContentLoaded', () => {
    butConnect.addEventListener('click', clickConnect);
    butSend.addEventListener('click', clickSend);

    const notSupported = document.getElementById('notSupported');
    notSupported.classList.toggle('hidden', 'serial' in navigator);
    document.querySelectorAll('img.pixelArt').forEach(initPixelArtImage);
    initGamma(DEFAULT_GAMMA);
    debugButton.onclick = function() { if (port) writeToStream('DBG'); };
    clockButton.onclick = function() { drawClockMinute([0xff, 0xff, 0xff], [0x00, 0x00, 0x00], [0x00, 0x00, 0xff]); };
});


/**
 * @name paddedHex
 * Return the hex string representation of `number`, padded to `width` places.
 */
function paddedHex(number, width) {
    return number.toString(16).padStart(width, '0').toUpperCase();
}


/**
 * @name connect
 * Opens a Web Serial connection to the board and sets up the input and
 * output stream.
 */
async function connect() {
    const ports = await navigator.serial.getPorts();
    try {
	if (ports.length == 1) {
	    port = ports[0];
	} else {
	    port = await navigator.serial.requestPort();
	}
	await port.open({ baudRate: 115200 });
    } catch (e) {
	return;
    }

    const encoder = new TextEncoderStream();
    outputDone = encoder.readable.pipeTo(port.writable);
    outputStream = encoder.writable;
    writeToStream('', 'RST', 'VER', 'PWR');

    let decoder = new TextDecoderStream();
    inputDone = port.readable.pipeTo(decoder.writable);
    inputStream = decoder.readable.pipeThrough(new TransformStream(new LineBreakTransformer()));
    reader = inputStream.getReader();
    readLoop();
}


/**
 * @name disconnect
 * Closes the Web Serial connection.
 */
async function disconnect() {
    writeToStream('RST');
    if (reader) {
	await reader.cancel();
	await inputDone.catch(() => {});
	reader = null;
	inputDone = null;
    }
    if (outputStream) {
	await outputStream.getWriter().close();
	await outputDone;
	outputStream = null;
	outputDone = null;
    }
    await port.close();
    port = null;
}


/**
 * @name clickConnect
 * Click handler for the connect/disconnect button.
 */
async function clickConnect() {
    if (port) {
	await disconnect();
	toggleUIConnected(false);
	return;
    }
    await connect();
    toggleUIConnected(true);
    if (currentImage)
	sendGifAnimation(currentImage);
}


/**
 * @name clickSend
 * Opens Send a command to the board
 */
async function clickSend() {
    if (!port) return;
    writeToStream(commandTextInput.value);
}


/**
 * @name readLoop
 * Reads data from the input stream and displays it on screen.
 */
async function readLoop() {
    while (true) {
	const { value, done } = await reader.read();
	if (value) {
	    console.log('[RECV]' + value + '\n');
	}
	if (done) {
	    console.log('[readLoop] DONE', done);
	    reader.releaseLock();
	    break;
	}
    }
}


class Frame {
    constructor(ms, pixels) {
	this.duration = ms;
	this.rows = Array.from(pixels, row => Array.from(
	      row, ([r, g, b]) => paddedHex(gammaTable[r]<<16 | gammaTable[g] << 8 | gammaTable[b], 6)).join(''));
    }
}


class Animation{
    constructor(ms) {
	this.duration = ms;
	this.frames = [];
    }

    addFrame(f) {
	this.frames.push(f);
    }
}


function sendAnimation(anim) {
    writeToStream('ANM ' + anim.duration);
    anim.frames.forEach(function(frame) {
	writeToStream('FRM ' + frame.duration);
	frame.rows.forEach(row => writeToStream('RGB ' + row));
    });
    writeToStream('DON', 'NXT');
}


/**
 * @name sendGifAnimation
 * Sends a GIF animation to the display
 */
function sendGifAnimation(img) {
    var oReq = new XMLHttpRequest();
    oReq.open('GET', img.src, true);
    oReq.responseType = 'arraybuffer';

    oReq.onload = function(oEvent) {
	var arrayBuffer = oReq.response;
	if (arrayBuffer) {
	    var gif = parseGIF(arrayBuffer);
	    if (gif.lsd.width != ROWS || gif.lsd.height != COLS)
		return;
	    var frames = decompressFrames(gif, true);
	    if (frames) {
		var animation = new Animation(600000);
		var pixels = Array(ROWS).fill().map(() => Array(COLS));
		frames.forEach(function(gifFrame) {
		    pixels.forEach(row => row.fill(0));
		    var bitmap = gifFrame.patch;
		    var row_offset = gifFrame.dims.top;
		    var col_offset = gifFrame.dims.left;
		    for (var r = 0; r < gifFrame.dims.height; r++) {
			for (var c = 0; c < gifFrame.dims.width; c++) {
			    var offset = (r * gifFrame.dims.width + c) * 4;
			    pixels[r+row_offset][c+col_offset] = [bitmap[offset], bitmap[offset+1], bitmap[offset+2]];
			}
		    }
		    animation.addFrame(new Frame('delay' in gifFrame ? gifFrame.delay : 1000, pixels));
		});
		sendAnimation(animation);
	    }
	}
    }
    oReq.send(null)
}


/**
 * @name writeToStream
 * Gets a writer from the output stream and send the lines to the micro:bit.
 * @param  {...string} lines lines to send to the micro:bit
 */
function writeToStream(...lines) {
    const writer = outputStream.getWriter();
    lines.forEach((line) => {
	console.log('[SEND]', line);
	writer.write(line + '\n');
    });
    writer.releaseLock();
}

/**
 * @name LineBreakTransformer
 * TransformStream to parse the stream into lines.
 */
class LineBreakTransformer {
    constructor() {
	// A container for holding stream data until a new line.
	this.container = '';
    }

    transform(chunk, controller) {
	this.container += chunk;
	const lines = this.container.split('\n');
	this.container = lines.pop();
	lines.forEach(line => controller.enqueue(line));
    }

    flush(controller) {
	controller.enqueue(this.container)
    }
}


function initPixelArtImage(img) {
    img.crossOrigin = "Anonymous";
    img.onclick = function() {
	if (port) sendGifAnimation(img);
	currentImage = img;
    }
}

function gammaValueFromSlider(v) {
    return MIN_GAMMA + v*(MAX_GAMMA-MIN_GAMMA)/100.0;
}

function sliderValueFromGamma(g) {
    return (g-MIN_GAMMA)*100.0/(MAX_GAMMA-MIN_GAMMA);
}

function updateSliderDisplay(slider, display) {
    gammaDisplay.innerHTML = gammaValueFromSlider(gammaSlider.value).toFixed(2);
}

function updateGamma() {
    var gamma = gammaValueFromSlider(gammaSlider.value);
    let i = 0;
    gammaTable = Array.from(Array(256), () => Math.round(255*((i++/255.0)**gamma)));
    if (currentImage) {
	sendGifAnimation(currentImage);
    }
}

function initGamma(g) {
    gammaSlider.value = sliderValueFromGamma(g);
    gammaSlider.oninput = function () {
	updateSliderDisplay(gammaSlider, gammaDisplay);
    };
    gammaSlider.oninput();
    gammaSlider.onchange = updateGamma;
    updateGamma();
}

function toggleUIConnected(connected) {
    let lbl = 'Connect';
    if (connected) {
	lbl = 'Disconnect';
    }
    butConnect.textContent = lbl;
}

const DIGIT_ROWS = 5;
const CLOCK_VERTICAL_OFFSET = 5;
const Digits = [
  [[1,1,1],
   [1,0,1],
   [1,0,1],
   [1,0,1],
   [1,1,1]],
  [[0,1,0],
   [1,1,0],
   [0,1,0],
   [0,1,0],
   [1,1,1]],
  [[1,1,0],
   [0,0,1],
   [0,1,0],
   [1,0,0],
   [1,1,1]],
  [[1,1,1],
   [0,0,1],
   [0,1,1],
   [0,0,1],
   [1,1,1]],
  [[1,0,1],
   [1,0,1],
   [1,1,1],
   [0,0,1],
   [0,0,1]],
  [[1,1,1],
   [1,0,0],
   [1,1,0],
   [0,0,1],
   [1,1,0]],
  [[1,1,1],
   [1,0,0],
   [1,1,1],
   [1,0,1],
   [1,1,1]],
  [[1,1,1],
   [0,0,1],
   [0,1,0],
   [0,1,0],
   [0,1,0]],
  [[1,1,1],
   [1,0,1],
   [1,1,1],
   [1,0,1],
   [1,1,1]],
  [[1,1,1],
   [1,0,1],
   [1,1,1],
   [0,0,1],
   [1,1,1]]
];

function* fillRowIterator(color) {
    for (var c = 0; c < COLS; c++) yield color;
}

function* bitmapRowIterator(row, fg, bg) {
    for (var i = 0; i < row.length; i++) yield row[i] ? fg : bg;
}

function* digitRowIterator(row, h10, h1, m10, m1, fg, bg, colon) {
    yield* bitmapRowIterator(Digits[h10][row], fg, bg);
    yield bg;
    yield* bitmapRowIterator(Digits[h1][row], fg, bg);
    var center = row % 2 ? colon : bg;
    yield center;
    yield center;
    yield* bitmapRowIterator(Digits[m10][row], fg, bg);
    yield bg;
    yield* bitmapRowIterator(Digits[m1][row], fg, bg);
}

function* digitalClockIterator(h10, h1, m10, m1, fg, bg, colon) {
    for (var r = 0; r < CLOCK_VERTICAL_OFFSET; r++) {
	yield fillRowIterator(bg);
    }
    for (var r = 0; r < DIGIT_ROWS; r++) {
	yield digitRowIterator(r, h10, h1, m10, m1, fg, bg, colon);
    }
    for (var r = 0; r < ROWS-(CLOCK_VERTICAL_OFFSET+DIGIT_ROWS); r++) {
	yield fillRowIterator(bg);
    }
}


function drawClockMinute(fg, bg, colon) {
    var t = new Date();
    var hours = t.getHours();
    var minutes = t.getMinutes();
    var animation = new Animation(60000);
    animation.addFrame(new Frame(500, digitalClockIterator(
	  Math.floor(hours/10), hours%10,Math.floor(minutes/10),minutes%10, fg, bg, colon)));
    animation.addFrame(new Frame(500, digitalClockIterator(
	  Math.floor(hours/10), hours%10,Math.floor(minutes/10),minutes%10, fg, bg, bg)));
    sendAnimation(animation);
}
