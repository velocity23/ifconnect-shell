/*

ifc2: A Node JS module providing a client the Infinite Flight Connect version 2 API.

Version: 1.0.22
Author: @likeablegeek (https://likeablegeek.com/)
Distributed by: FlightSim Ninja (http://flightim.ninja)

Copyright 2022.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

*/

/*****
 * Import required modules
 */
const dgram = require('dgram'); // For listening for UDP broadcasts
const net = require('net'); // For establishing socket connections
const events = require('events'); // For emitting events back to calling scripts
const { SlowBuffer } = require('buffer');
require('stringview'); // DataView extensions for reading/writing strings

/****
 * Define IFC2 object
 */
let IFC2 = {
    /*****
     * Module name
     */
    name: 'IFC2', // Module name

    /*****
     * Constants for referencing error levels in logging
     */
    INFO: 3,
    WARN: 2,
    ERROR: 1,
    MANDATORY: 0,

    /*****
     * Constants for sending the correct flag for get/set calls in v2 API
     */
    GETCMD: 0,
    SETCMD: 1,
    RUNCMD: -1,
    LE: true,

    /*****
     * Constant for the manifest command
     */
    MANIFESTCMD: -1,

    /*****
     * Constants for IF Connect v2 data types
     */
    BOOLEAN: 0,
    INTEGER: 1,
    FLOAT: 2,
    DOUBLE: 3,
    STRING: 4,
    LONG: 5,

    /*****
     * Object to hold connection data, manifest data, socket objects and more
     */
    infiniteFlight: {
        // Infinite Flight connection data
        broadcastPort: 15000, // Port to listen for broadcast from Infinite Flight
        serverPort: 10112, // Port for socket connection to Infinite Flight
        serverAddress: '127.0.0.1', // Default is localhost just as a placeholder
        clientSocket: new net.Socket(), // Socket for regular one-off commands
        manifestSocket: new net.Socket(), // Socket for fetching the manifest
        pollSocket: new net.Socket(), // Socket for the regular polling loop
        manifestTimeout: 1000, // How long to wait for the manifest before giving up
        manifestData: '', // String to hold raw manifest data
        manifestByName: {}, // Object to hold the manifest organised by command name
        manifestByCommand: {}, // Object to hold the manifest organised by command number
        manifestLength: 0, // Manifest length -- zero is initial placeholder
        manifestBuffer: null, // Placeholder variable for future manifest buffer
    },

    /*****
     * Default logging state
     */
    enableLog: false, // Control logging -- default is false
    logLevel: this.MANDATORY, // Logging message level -- default is MANDATORY

    /*****
     * Default keepalive, reconnect and timeout
     */
    keepAlive: false, // By default we don't keep alive
    doReconnect: true, // By default we reconnect when sockets error
    timeout: 0, // By default we don't time out the sockets (except the manifest)

    /*****
     * State tracking: are we connected? are we waiting?
     */
    isConnected: false, // Are we connected to IF?
    isWaiting: false, // Are we waiting?
    isPollWaiting: false, // Are we waiting for a poll result?,
    isCallback: false, // Are we using callbacks?

    /*****
     * Command queues
     */
    q: [], // Queue for processing one-off requests
    pollQ: [], // Queue for recurring poll requests
    pollCurrent: 0, // Position in poll queue,
    pollWaiting: 0, // Place holder for poll command currently pending data from IF
    callbacks: {}, // Holds callback functions for when callbacks are enabled

    /*****
     * Timeout placeholder for slow polling handler
     */
    pollTimeout: null,

    /*****
     *
     * Queue buffers
     *
     */

    qBuffer: null,
    pollBuffer: null,

    /*****
     * List to keep track of the commands pending responses from IF
     */
    waitList: [],

    /*****
     * Event emitter for return events to client
     */
    eventEmitter: new events.EventEmitter(),

    /*****
     * Default empty infoCallback function
     */

    infoCallback: () => {},

    /*****
     * Default polling throttle (0ms)
     */

    pollThrottle: 0,

    /*****
     * Object to hold last value fetched for all states that have been fetched from API
     */
    ifData: {},

    /*****
     * Logging function
     */
    log: (msg, level = IFC2.logLevel) => {
        // generic logging function
        if (IFC2.enableLog) {
            if (level <= IFC2.logLevel) {
                let info = '(';
                info += IFC2.isConnected ? 'c' : '';
                info += IFC2.isWaiting ? 'w' : '';
                info += IFC2.q.length;
                info += IFC2.pollQ.length;
                info += ')';
            }
        }
    },

    /*****
     * Function to allow client to define listener for events emitted by module
     */
    on: (event, listener) => {
        IFC2.log('Setting listener for: ' + event);
        IFC2.eventEmitter.on(event, listener);
    },

    /*****
     * Returns command formatted to send on TCP socket to API for getState commands
     */
    getCommand: (cmd, args) => {
        // Prepare command ready to send to IF

        IFC2.log('getCommand: ' + cmd);

        let argsLength = 0;
        if (args) {
            argsLength = 4;
            for (let i = 0; i < args.length; i++) {
                let arg = args[i];
                argsLength += 4 + arg.name.length + 4 + arg.value.length;
            }
        }

        let abCommand = new ArrayBuffer(5 + argsLength);
        let dvCommand = new DataView(abCommand);
        dvCommand.setInt32(0, cmd, IFC2.LE); // Encode the command itself
        dvCommand.setInt8(4, args ? IFC2.SETCMD : IFC2.GETCMD, IFC2.LE); // Encode get marker
        if (args) {
            let offset = 5;
            dvCommand.setInt32(offset, args.length, IFC2.LE); // Encode number of arguments
            offset += 4;
            for (let i = 0; i < args.length; i++) {
                let arg = args[i];
                dvCommand.setInt32(offset, arg.name.length, IFC2.LE); // Encode length of argument name
                offset += 4;
                for (let j = 0; j < arg.name.length; j++) {
                    dvCommand.setInt8(offset, arg.name.charCodeAt(j), IFC2.LE); // Encode argument name
                    offset++;
                }
                dvCommand.setInt32(offset, arg.value.length, IFC2.LE); // Encode length of argument value
                offset += 4;
                for (let j = 0; j < arg.value.length; j++) {
                    dvCommand.setInt8(offset, arg.value.charCodeAt(j), IFC2.LE); // Encode argument value
                    offset++;
                }
            }
        }
        let u8Command = new Uint8Array(abCommand);

        IFC2.log('getCommand: ' + u8Command);

        return u8Command;
    },

    /*****
     * Sends command formatted to send on TCP socket to API for setState commands
     */
    setCommand: (cmd, val) => {
        // Prepare command ready to send to IF

        IFC2.log('setCommand: ' + cmd + ',' + val, IFC2.MANDATORY);

        let cmdType = IFC2.infiniteFlight.manifestByCommand[cmd].type;

        let dataLength = 1;

        switch (cmdType) {
            case IFC2.INTEGER:
                dataLength = 4;
                break;
            case IFC2.FLOAT:
                dataLength = 4;
                break;
            case IFC2.DOUBLE:
                dataLength = 4;
                break;
            case IFC2.STRING:
                dataLength = 4 + val.length; // length is 4 for string length + string length
                break;
            case IFC2.LONG:
                dataLength = 8;
                break;
        }

        let abCommand = new ArrayBuffer(5 + dataLength); // 5 is command + true/false divider + value to be sent
        let dvCommand = new DataView(abCommand);
        dvCommand.setInt32(0, cmd, IFC2.LE); // Encode the command itself
        dvCommand.setInt8(4, IFC2.SETCMD, IFC2.LE); // Encode set marker

        switch (cmdType) {
            case IFC2.BOOLEAN:
                dvCommand.setInt8(5, val, true);
                break;
            case IFC2.INTEGER:
                dvCommand.setInt32(5, val, true);
                break;
            case IFC2.FLOAT:
                dvCommand.setFloat32(5, val, true);
                break;
            case IFC2.DOUBLE:
                dvCommand.setFloat64(5, val, true);
                break;
            case IFC2.STRING:
                dvCommand.setInt32(5, val.length, true);
                dvCommand.setString(9, val);
                break;
            case IFC2.LONG:
                dvCommand.setBigInt64(5, val, true);
                break;
        }

        let u8Command = new Uint8Array(abCommand);

        IFC2.log('setCommand u8Command: ' + u8Command, IFC2.MANDATORY);

        IFC2.log(dvCommand, IFC2.MANDATORY);

        return u8Command;
    },

    /*****
     * Process next command in one-off command queue (if any commands are pending)
     */
    processQueue: () => {
        IFC2.log('processQueue: isConnected: ' + IFC2.isConnected);
        IFC2.log('processQueue: isWaiting: ' + IFC2.isWaiting);

        if (IFC2.isConnected && !IFC2.isWaiting) {
            // only send if connected and not already waiting for a response

            IFC2.log('Q length: ' + IFC2.q.length);

            if (IFC2.q.length > 0) {
                // only send if there is a command in the queue

                let cmdObj = IFC2.q.shift(); // grab the next command from the queue

                if (IFC2.infiniteFlight.manifestByName[cmdObj.cmd]) {
                    // only send if the command is in the manifest

                    IFC2.isWaiting = true; // indicate we are now waiting for a response

                    IFC2.log('Sending command: ' + cmdObj.cmdCode);

                    IFC2.infiniteFlight.clientSocket.write(
                        cmdObj.cmdBuf,
                        () => {
                            // Send the command
                            IFC2.waitList.push(cmdObj.cmdCode); // Add the command to the wait list
                            IFC2.log('Command sent: ' + cmdObj.cmdCode);
                        }
                    );
                }
            } else {
                setTimeout(IFC2.processQueue, 250); // No command in queue -- try again in 250ms
            }
        }
    },

    /****
     * Add a one-off command to the command queue
     */
    enqueueCommand: (cmd, action = IFC2.GETCMD, val) => {
        IFC2.log('Enqueueing: ' + cmd + ',' + action);

        let cmdCode = IFC2.infiniteFlight.manifestByName[cmd].command; // Get the command code

        let cmdBuf =
            action == IFC2.GETCMD
                ? IFC2.getCommand(cmdCode)
                : action == IFC2.RUNCMD
                ? IFC2.getCommand(cmdCode, val)
                : IFC2.setCommand(cmdCode, val);

        if (action == IFC2.GETCMD) {
            IFC2.q.push({ cmd: cmd, cmdCode: cmdCode, cmdBuf: cmdBuf }); // Push the command into the queue
            IFC2.log(IFC2.q);
            if (IFC2.q.length > 0 && !IFC2.isWaiting) {
                IFC2.processQueue();
            } // If not currently waiting for a response, start processing the queue
        } else if (action == IFC2.SETCMD) {
            IFC2.infiniteFlight.clientSocket.write(cmdBuf, () => {
                // Send the command
                IFC2.log('SetState Command sent: ' + cmdBuf);
            });
        } else if (action == IFC2.RUNCMD) {
            IFC2.infiniteFlight.clientSocket.write(cmdBuf, () => {
                // Send the command
                IFC2.log('Run Command sent: ' + cmdBuf);
            });
        }
    },

    /*****
     * Function for client to request a one-off get command
     */
    get: (cmd, callback) => {
        IFC2.log('Processing get request: ' + cmd);

        if (IFC2.isConnected) {
            // Only enqueue if connected

            if (IFC2.isCallback) {
                // Save the callback function if we are using it
                IFC2.callbacks[cmd] = callback;
            }

            IFC2.enqueueCommand(cmd, IFC2.GETCMD);
        }
    },

    /*****
     * Function for client to request a one-off get command
     */
    set: (cmd, val) => {
        IFC2.log('Processing set request: ' + cmd + ',' + val);

        if (IFC2.isConnected) {
            // Only enqueue if connected
            IFC2.enqueueCommand(cmd, IFC2.SETCMD, val);
        }
    },

    /*****
     * Function run an Infinite Flight command
     */
    run: (cmd, args) => {
        IFC2.log('Processing run request: ' + cmd);

        if (IFC2.isConnected) {
            // Only enqueue if connected
            IFC2.enqueueCommand(cmd, IFC2.RUNCMD, args);
        }
    },

    /*****
     * Process the manifest after fetching it
     */
    processManifest: () => {
        IFC2.log('Processing manifest into objects');

        let manifestLines = IFC2.infiniteFlight.manifestData.split('\n'); // Split the data into lines

        for (key in manifestLines) {
            // Loop through the lines

            let line = manifestLines[key];

            let lineData = line.split(','); // Split the line at commas

            let command = parseInt(lineData[0]); // Get the command
            let type = parseInt(lineData[1]); // Get the command data type
            let name = lineData[2]; // Get the command name

            if (!isNaN(command)) {
                // Save the manifest data for this command
                IFC2.infiniteFlight.manifestByCommand[command] = {
                    name: name,
                    type: type,
                };
                IFC2.infiniteFlight.manifestByName[name] = {
                    command: command,
                    type: type,
                };
            }
        }

        // Emit Event
        IFC2.eventEmitter.emit(
            'IFC2manifest',
            IFC2.infiniteFlight.manifestByName
        ); // Return data to calling script through an event

        // Move on to post-manifest actions
        IFC2.postManifest();
    },

    /*****
     * Return the manifest by name
     */
    manifestByName: () => {
        return IFC2.infiniteFlight.manifestByName;
    },

    /*****
     * Return the manifest by command
     */
    manifestByCommand: () => {
        return IFC2.infiniteFlight.manifestByCommand;
    },

    /*****
     * Get the manifest
     */
    getManifest: () => {
        IFC2.log('Getting manifest from: ' + IFC2.infiniteFlight.serverAddress);

        // Reset manifest data variables
        IFC2.infiniteFlight.manifestData = '';
        IFC2.infiniteFlight.manifestByName = {};
        IFC2.infiniteFlight.manifestByCommand = {};
        IFC2.infiniteFlight.manifestLength = 0;
        IFC2.infiniteFlight.manifestBuffer = null;

        // Set up connection to the manifest socket
        IFC2.infiniteFlight.manifestSocket.on('data', (data) => {
            // Handle "data" event

            IFC2.log('Receiving Manifest Data');

            if (IFC2.infiniteFlight.manifestBuffer == null) {
                // We haven't stored any buffer data yet

                // Store the first batch of data in the buffer
                IFC2.infiniteFlight.manifestBuffer = data;
            } else {
                // We already have buffer data

                // Concat the new buffer data into the main manifest buffer
                let bufArr = [IFC2.infiniteFlight.manifestBuffer, data];
                IFC2.infiniteFlight.manifestBuffer = Buffer.concat(bufArr);
            }

            IFC2.log(
                'Buffer length: ' + IFC2.infiniteFlight.manifestBuffer.length
            );

            if (
                IFC2.infiniteFlight.manifestLength <= 0 &&
                IFC2.infiniteFlight.manifestBuffer.length >= 12
            ) {
                // The first 12 bytes of the manifest are:
                //
                // 4 bytes: Int32 (-10 to specify the manifest command
                // 4 bytes: Int32 Specify the length of all data to follow
                // 4 bytes: Int32 specifying the length of the manifest data string to follow (so this is always four less than the preceding Int 32 value)

                // If we don't have a manifest length and we have at least three Int32s in the buffer, get the manifest length from bytes 9-12
                IFC2.infiniteFlight.manifestLength =
                    IFC2.infiniteFlight.manifestBuffer.readInt32LE(8);

                IFC2.log(
                    'Manifest length: ' + IFC2.infiniteFlight.manifestLength
                );
            } else {
                // Check if we have hit the manifest length -- and remember the manifest length will be 12 less than the buffer length because
                // the first 12 bytes are not part of the manifest itself
                if (
                    IFC2.infiniteFlight.manifestBuffer.length >=
                    IFC2.infiniteFlight.manifestLength + 12
                ) {
                    // Convert buffer to a string
                    IFC2.infiniteFlight.manifestData =
                        IFC2.infiniteFlight.manifestBuffer.toString('utf8', 12);

                    IFC2.log(IFC2.infiniteFlight.manifestData);

                    // Close the manifest socket
                    IFC2.infiniteFlight.manifestSocket.destroy();

                    // Process the manifest
                    IFC2.processManifest();
                }
            }

            IFC2.log('-----');
        });

        IFC2.infiniteFlight.manifestSocket.on('timeout', () => {
            // Handle "timeout" evenet

            IFC2.log('Manifest data done/timed out');
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'timeout',
                context: 'manifest',
                msg: 'Manifest socket connection to Infinite Flight timed out',
            }); // Return data to calling script through an event

            IFC2.infiniteFlight.manifestSocket.destroy(); // Destroy the socket
        });

        IFC2.infiniteFlight.manifestSocket.on('close', () => {
            // Handle "close" event
            IFC2.log('Manifest Connection closed');
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'close',
                context: 'manifest',
                msg: 'Manifest socket connection to Infinite Flight closed',
            }); // Return data to calling script through an event
        });

        //    IFC2.infiniteFlight.manifestSocket.on('connect', () => { // Handle "connect" event
        //    });

        IFC2.infiniteFlight.manifestSocket.on('error', function (data) {
            IFC2.log('Error: ' + data, IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'error',
                context: 'manifest',
                msg: 'Error on Infinite Flight manifest socket',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.manifestSocket.on('drain', function (data) {
            IFC2.log('Drain: ' + data, IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'drain',
                context: 'manifest',
                msg: 'Manifest socket connection to Infinite Flight drained',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.manifestSocket.on('end', function (data) {
            IFC2.log('End: ' + data, IFC2.WARN);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'end',
                context: 'manifest',
                msg: 'Manifest socket connection to Infinite Flight ended',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.manifestSocket.on('lookup', function (data) {
            IFC2.log('Lookup: ' + data, IFC2.INFO);
        });

        IFC2.infiniteFlight.manifestSocket.connect(
            IFC2.infiniteFlight.serverPort,
            IFC2.infiniteFlight.serverAddress,
            () => {
                IFC2.log('Manifest Connected');
                IFC2.eventEmitter.emit('IFC2msg', {
                    type: 'info',
                    code: 'connect',
                    context: 'manifest',
                    msg: 'Manifest socket connection to Infinite Flight created',
                }); // Return data to calling script through an event
                IFC2.infiniteFlight.manifestSocket.setTimeout(
                    IFC2.infiniteFlight.manifestTimeout
                ); // Set the socket timeout
                IFC2.infiniteFlight.manifestSocket.write(
                    IFC2.getCommand(IFC2.MANIFESTCMD),
                    () => {}
                ); // Issue the get manifest command (-1)
            }
        );
    },

    /*****
     * Place holder to hold success callback function provided by client
     */
    successCallback: () => {},

    /*****
     * Process the poll queue
     */
    processPoll: () => {
        IFC2.log('Processing poll Q');

        if (IFC2.pollQ.length > 0 && !IFC2.isPollWaiting) {
            // Only process if the queue has entries and we are not waiting for data from IF

            IFC2.log(IFC2.pollQ);

            // Get current command to process
            let cmd = IFC2.pollQ[IFC2.pollCurrent];
            let cmdCode = IFC2.infiniteFlight.manifestByName[cmd].command; // Get the command code

            IFC2.log('Polling command: ' + cmdCode);

            // Prep for next poll
            IFC2.pollCurrent =
                IFC2.pollCurrent + 1 == IFC2.pollQ.length
                    ? 0
                    : IFC2.pollCurrent + 1;

            // Set isPollWaiting
            IFC2.isPollWaiting = true;

            // Send the command
            if (IFC2.pollThrottle > 0) {
                // Wait before polling
                setTimeout(() => {
                    IFC2.infiniteFlight.pollSocket.write(
                        IFC2.getCommand(cmdCode),
                        () => {
                            IFC2.log('Poll command sent: ' + cmdCode);
                            if (IFC2.waitList.indexOf(cmdCode) < 0) {
                                // Check if we are already waiting for this command

                                IFC2.waitList.push(cmdCode); // Add the command to the wait list

                                IFC2.pollWaiting = cmdCode;
                            }
                        }
                    );
                }, IFC2.pollThrottle);
            } else {
                // Don't delay -- just get on and poll

                if (IFC2.waitList.indexOf(cmdCode) < 0) {
                    // Check if we are already waiting for this command

                    IFC2.infiniteFlight.pollSocket.write(
                        IFC2.getCommand(cmdCode),
                        () => {
                            IFC2.log('Poll command sent: ' + cmdCode);

                            IFC2.waitList.push(cmdCode); // Add the command to the wait list

                            IFC2.pollWaiting = cmdCode;
                        }
                    );
                }
            }
        } else {
            // There was nothing in the queue

            IFC2.log('Set poll timeout');
        }
    },

    /*****
     * Register a command into the poll queue
     */
    pollRegister: (cmd, callback) => {
        if (!IFC2.pollQ.hasOwnProperty(cmd)) {
            if (IFC2.isCallback) {
                // Save callback function if we are using callbacks
                IFC2.callbacks[cmd] = callback;
            }

            IFC2.pollQ.push(cmd);
            if (!IFC2.isPollWaiting) {
                IFC2.processPoll();
            }
        }
    },

    /*****
     * Deregister a command from the poll queue
     */
    pollDeregister: (cmd) => {
        let index = IFC2.pollQ.indexOf(cmd);
        IFC2.pollQ.splice(index, 1);

        if (IFC2.pollCurrent >= IFC2.pollQ.length) {
            IFC2.pollCurrent = 0;
        }

        if (IFC2.pollQ.length == 0) {
            IFC2.isPollWaiting = false;
        }
    },

    /*****
     * Process command data returned by the API
     *
     * nextFN is a function to call after data processing is done
     */
    processData: (source, nextFN) => {
        IFC2.log('processData: Processing data source: ' + source, IFC2.INFO);

        let data = source == 'client' ? IFC2.qBuffer : IFC2.pollBuffer;

        let command = data.readInt32LE(0); // Get the command from the data

        IFC2.log('processData: Got data for command: ' + command);
        let inManifest =
            IFC2.infiniteFlight.manifestByCommand.hasOwnProperty(command); // See if command is in manifest

        IFC2.log('processData: inManifest: ' + inManifest);

        if (inManifest) {
            // Only proceed if we have the command in the manifest

            let waitIndex = IFC2.waitList.indexOf(command); // See if the command is in the waitList

            IFC2.log('processData: waitList: ' + JSON.stringify(IFC2.waitList));
            IFC2.log('processData: In waitList: ' + waitIndex);

            if (waitIndex >= 0) {
                // Only proceed if command is in the waitList

                IFC2.log('processData: Waiting for command: ' + command);

                IFC2.log('processData: data length: ' + data.length);

                if (data.length > 4) {
                    // See if we have a data length greater than 4

                    IFC2.log('processData: data length gt 4');

                    let bufLength = data.readInt32LE(4);

                    if (data.length >= bufLength + 8) {
                        // Do we have the full command data?

                        IFC2.log('processData: data is complete so process');

                        IFC2.log(data);

                        IFC2.log(
                            'processData: waitList before splice: ' +
                                JSON.stringify(IFC2.waitList)
                        );

                        IFC2.waitList.splice(waitIndex, 1);

                        IFC2.log(
                            'processData: waitList after  splice: ' +
                                JSON.stringify(IFC2.waitList)
                        );

                        switch (
                            IFC2.infiniteFlight.manifestByCommand[command].type
                        ) {
                            case IFC2.BOOLEAN:
                                IFC2.processResult(
                                    command,
                                    data.readUInt8(8) == 1 ? true : false
                                );
                                break;
                            case IFC2.INTEGER:
                                IFC2.processResult(
                                    command,
                                    data.readUInt32LE(8)
                                );
                                break;
                            case IFC2.FLOAT:
                                IFC2.processResult(
                                    command,
                                    data.readFloatLE(8)
                                );
                                break;
                            case IFC2.DOUBLE:
                                IFC2.processResult(
                                    command,
                                    data.readDoubleLE(8)
                                );
                                break;
                            case IFC2.STRING:
                                strLen = data.readUInt32LE(8);
                                IFC2.processResult(
                                    command,
                                    data.toString('utf8', 12, strLen + 12)
                                );
                                break;
                            case IFC2.LONG:
                                IFC2.processResult(
                                    command,
                                    data.readBigInt64LE(8)
                                );
                                break;
                        }

                        // remove data from buffer

                        if (source == 'client') {
                            if (data.length > bufLength + 8) {
                                IFC2.qBuffer = IFC2.qBuffer.slice(
                                    bufLength + 8,
                                    IFC2.qBuffer.length
                                );
                            } else {
                                IFC2.qBuffer = null;
                                if (IFC2.waitList.length == 0) {
                                    IFC2.isWaiting = false; // No longer waiting
                                }
                            }
                        } else {
                            if (data.length > bufLength + 8) {
                                IFC2.pollBuffer = IFC2.pollBuffer.slice(
                                    bufLength + 8,
                                    IFC2.pollBuffer.length
                                );
                            } else {
                                IFC2.pollBuffer = null;
                                IFC2.isPollWaiting = false; // No longer waiting
                            }
                        }

                        nextFN();
                    } else {
                        nextFN();
                    }
                } else {
                    nextFN();
                }
            } else {
                nextFN();
            }
        } else {
            nextFN();
        }
    },

    /*****
     * After processing the manifest, connect to IF Connect v2 API
     */
    postManifest: function () {
        IFC2.infiniteFlight.clientSocket.connect(
            IFC2.infiniteFlight.serverPort,
            IFC2.infiniteFlight.serverAddress,
            function () {
                IFC2.infiniteFlight.clientSocket.setTimeout(IFC2.timeout);
                IFC2.infiniteFlight.clientSocket.setKeepAlive(IFC2.keepAlive);
            }
        );

        IFC2.infiniteFlight.clientSocket.on('data', function (data) {
            IFC2.log('***** Received: ' + data, IFC2.INFO);

            if (IFC2.qBuffer == null) {
                // We haven't stored any buffer data yet

                // Store the first batch of data in the buffer
                IFC2.qBuffer = data;
            } else {
                // We already have buffer data

                // Concat the new buffer data into the main manifest buffer
                let bufArr = [IFC2.qBuffer, data];
                IFC2.qBuffer = Buffer.concat(bufArr);
            }

            IFC2.processData('client', IFC2.processQueue);
        });

        IFC2.infiniteFlight.clientSocket.on('error', function (data) {
            IFC2.log('Client: Error: ' + JSON.stringify(data), IFC2.INFO);

            if (IFC2.isConnected && IFC2.doReconnect) {
                IFC2.log('Client: Trying to reconnect');
                IFC2.eventEmitter.emit('IFC2msg', {
                    type: 'info',
                    code: 'reconnect',
                    context: 'client',
                    msg: 'Reconnecting for general queries',
                }); // Return data to calling script through an event
                IFC2.infiniteFlight.clientSocket.destroy();
                //          IFC2.infiniteFlight.pollSocket = new net.Socket();
                IFC2.infiniteFlight.clientSocket.connect(
                    IFC2.infiniteFlight.serverPort,
                    IFC2.infiniteFlight.serverAddress,
                    function () {
                        IFC2.infiniteFlight.clientSocket.setTimeout(
                            IFC2.timeout
                        );
                        IFC2.infiniteFlight.clientSocket.setKeepAlive(
                            IFC2.keepAlive
                        );
                        IFC2.eventEmitter.emit('IFC2msg', {
                            type: 'info',
                            code: 'reconnected',
                            context: 'client',
                            msg: 'Reconnected for general queries',
                        }); // Return data to calling script through an event
                    }
                );
            }

            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'error',
                context: 'client',
                msg: 'Error on Infinite Flight socket',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.clientSocket.on('timeout', function (data) {
            IFC2.log('Client: Timeout: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'timeout',
                context: 'client',
                msg: 'Timeout on  socket connection to Infinite Flight',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.clientSocket.on('close', function (data) {
            IFC2.log('Client: Closer: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'close',
                context: 'client',
                msg: 'Socket connection to Infinite Flight closed',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.clientSocket.on('connect', function (data) {
            IFC2.log(
                'Connected to IF server ' + IFC2.infiniteFlight.serverAddress,
                IFC2.MANDATORY
            );

            /*      if (IFC2.isConnected && IFC2.infiniteFlight.keepAlive) {
        IFC2.infiniteFlight.clientSocket.connect(IFC2.infiniteFlight.serverPort, IFC2.infiniteFlight.serverAddress, function() {
          IFC2.infiniteFlight.clientSocket.setTimeout(IFC2.timeout);
          IFC2.infiniteFlight.clientSocket.setKeepAlive(IFC2.keepAlive);
        });
      }*/

            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'connect',
                context: 'client',
                msg: 'Socket connection to Infinite Flight created',
            }); // Return data to calling script through an event
            if (!IFC2.isConnected) {
                IFC2.postConnect();
            }
        });

        IFC2.infiniteFlight.clientSocket.on('drain', function (data) {
            IFC2.log('Client: Drain: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'drain',
                context: 'client',
                msg: 'Socket connection to Infinite Flight drained',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.clientSocket.on('end', function (data) {
            IFC2.log('Client: End: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'end',
                context: 'client',
                msg: 'Socket connection to Infinite Flight ended',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.clientSocket.on('lookup', function (data) {
            IFC2.log('Client: Lookup: ' + JSON.stringify(data), IFC2.INFO);
        });
    },

    /*****
     * Pre-connection tasts
     */
    preConnect: function () {
        IFC2.log('Connecting...', IFC2.INFO);
        IFC2.getManifest();
    },

    /*****
     * Post-connection tasks
     */
    postConnect: function () {
        IFC2.log('clientSocket Connected ...', IFC2.MANDATORY);

        // Connect to Polling Socket
        IFC2.infiniteFlight.pollSocket.connect(
            IFC2.infiniteFlight.serverPort,
            IFC2.infiniteFlight.serverAddress,
            function () {
                IFC2.infiniteFlight.pollSocket.setTimeout(IFC2.timeout);
                IFC2.infiniteFlight.pollSocket.setKeepAlive(IFC2.keepAlive);
            }
        );

        IFC2.infiniteFlight.pollSocket.on('data', function (data) {
            IFC2.log('Received poll: ' + data, IFC2.INFO);

            if (IFC2.pollBuffer == null) {
                // We haven't stored any buffer data yet

                // Store the first batch of data in the buffer
                IFC2.pollBuffer = data;
            } else {
                // We already have buffer data

                // Concat the new buffer data into the main manifest buffer
                let bufArr = [IFC2.pollBuffer, data];
                IFC2.pollBuffer = Buffer.concat(bufArr);
            }

            // Clear poll timeout
            clearTimeout(IFC2.pollTimeout);

            IFC2.processData('poll', IFC2.processPoll);
        });

        IFC2.infiniteFlight.pollSocket.on('error', function (data) {
            IFC2.log('Poll: Error: ' + JSON.stringify(data), IFC2.INFO);

            if (IFC2.isConnected && IFC2.doReconnect) {
                IFC2.log('Poll: Trying to reconnect');
                IFC2.eventEmitter.emit('IFC2msg', {
                    type: 'info',
                    code: 'reconnect',
                    context: 'poll',
                    msg: 'Reconnecting for polling',
                }); // Return data to calling script through an event
                IFC2.infiniteFlight.pollSocket.destroy();
                //          IFC2.infiniteFlight.pollSocket = new net.Socket();
                IFC2.infiniteFlight.pollSocket.connect(
                    IFC2.infiniteFlight.serverPort,
                    IFC2.infiniteFlight.serverAddress,
                    function () {
                        IFC2.infiniteFlight.pollSocket.setTimeout(IFC2.timeout);
                        IFC2.infiniteFlight.pollSocket.setKeepAlive(
                            IFC2.keepAlive
                        );
                        IFC2.isPollWaiting = false;
                        IFC2.eventEmitter.emit('IFC2msg', {
                            type: 'info',
                            code: 'reconnected',
                            context: 'poll',
                            msg: 'Reconnected for polling',
                        }); // Return data to calling script through an event
                        IFC2.processPoll();
                    }
                );
            }

            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'error',
                context: 'poll',
                msg: 'Error polling Infinite Flight',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.pollSocket.on('timeout', function (data) {
            IFC2.log('Poll: Timeout: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'error',
                code: 'timeout',
                context: 'poll',
                msg: 'Timeout on polling socket connection to Infinite Flight',
            }); // Return data to calling script through an event
            IFC2.processPoll();
        });

        IFC2.infiniteFlight.pollSocket.on('close', function (data) {
            IFC2.log('Poll: Close: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'close',
                context: 'poll',
                msg: 'Polling socket connection to Infinite Flight closed',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.pollSocket.on('connect', function (data) {
            IFC2.log(
                'Connected for polling to IF server ' +
                    IFC2.infiniteFlight.serverAddress,
                IFC2.MANDATORY
            );
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'connect',
                context: 'poll',
                msg: 'Polling socket connection to Infinite Flight created',
            }); // Return data to calling script through an event
            IFC2.isConnected = true;

            // Fetch one-time data about aircraft, IF, etc
            if (IFC2.isCallback) {
                IFC2.get('infiniteflight/app_state', IFC2.infoCallback);
                IFC2.get('infiniteflight/app_version', IFC2.infoCallback);
                IFC2.get('infiniteflight/api_version', IFC2.infoCallback);
                IFC2.get('aircraft/0/name', IFC2.infoCallback);
                IFC2.get('aircraft/0/livery', IFC2.infoCallback);
            } else {
                IFC2.get('infiniteflight/app_state');
                IFC2.get('infiniteflight/app_version');
                IFC2.get('infiniteflight/api_version');
                IFC2.get('aircraft/0/name');
                IFC2.get('aircraft/0/livery');
            }

            // Issue callback
            IFC2.successCallback();

            // Start Polling
            IFC2.processPoll();
        });

        IFC2.infiniteFlight.pollSocket.on('drain', function (data) {
            IFC2.log('Poll: Drain: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'drain',
                context: 'poll',
                msg: 'Polling socket connection to Infinite Flight drained',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.pollSocket.on('end', function (data) {
            IFC2.log('Poll: End: ' + JSON.stringify(data), IFC2.INFO);
            IFC2.eventEmitter.emit('IFC2msg', {
                type: 'info',
                code: 'end',
                context: 'poll',
                msg: 'Polling socket connection to Infinite Flight ended',
            }); // Return data to calling script through an event
        });

        IFC2.infiniteFlight.pollSocket.on('lookup', function (data) {
            IFC2.log('Poll: Lookup: ' + JSON.stringify(data), IFC2.INFO);
        });
    },

    /*****
     * Process results of data returned from IF
     */
    processResult: function (command, data) {
        IFC2.log('Processing result: ' + command + ' > ' + data);

        // Save data in ifData data object
        IFC2.ifData[IFC2.infiniteFlight.manifestByCommand[command].name] = {
            data: data,
            ts: Date.now(),
        };

        // Return IFC2data event
        if (IFC2.isCallback) {
            // Use a callback if one is available

            IFC2.callbacks[IFC2.infiniteFlight.manifestByCommand[command].name](
                {
                    command:
                        IFC2.infiniteFlight.manifestByCommand[command].name,
                    data: data,
                }
            );
        } else {
            // Use an event

            IFC2.eventEmitter.emit('IFC2data', {
                command: IFC2.infiniteFlight.manifestByCommand[command].name,
                data: data,
            }); // Return data to calling script through an event
        }
    },

    // SHORTCUTS FUNCTIONS //

    /*****
     * Initialise module and connection to IF
     */
    init: function (successCallback, params = {}) {
        IFC2.log('Initialisting IFC2');
        if (successCallback) IFC2.successCallback = successCallback; // Set success callback function
        if (params.enableLog) IFC2.enableLog = params.enableLog; // Set Logging on/off
        if (params.logLevel) IFC2.logLevel = params.logLevel; // Set logging message level
        if (params.keepAlive) IFC2.keepAlive = params.keepAlive; // Set keepalive
        if (params.doReconnect) IFC2.doReconnect = params.doReconnect; // Set reconnect
        if (params.timeout) IFC2.timeout = params.timeout; // Set socket timeout
        if (params.callback) IFC2.isCallback = params.callback; // Set if we are using callbacks
        if (params.infoCallback) IFC2.infoCallback = params.infoCallback; // Callback function for initial info fetches
        if (params.pollThrottle) IFC2.pollThrottle = params.pollThrottle; // Set polling throttle if provided
        if (params.host && params.port) {
            // Host provided so connect directly to it
            IFC2.infiniteFlight.serverAddress = params.host;
            IFC2.infiniteFlight.serverPort = params.port;
            IFC2.preConnect();
        } else {
            // No host provided so search for a host via UDP
            IFC2.searchHost(); // Search for Infinite Flight host
        }
    },

    /*****
     * Use UDP broadcast to find an IF client on the local network
     */
    searchHost: function () {
        // We only connect to the first device to respond.
        // If you have multiple devices on the network you might not connect to the device you want.
        //
        // Future roadmap: send an event for each one that answers to calling script and let them decide what to do

        IFC2.log('Searching for Infinite Flight device', IFC2.INFO);

        // Create udp server socket object.
        const server = dgram.createSocket('udp4');

        // Make udp server listen on port 8089.
        server.bind(IFC2.infiniteFlight.broadcastPort);

        // When udp server receive message.
        server.on('message', function (message) {
            IFC2.log('UDP broadcast received', IFC2.INFO);
            IFC2.log(message.toString(), IFC2.INFO);
            let data = JSON.parse(message.toString());
            let regex = /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]/;
            for (key in data.Addresses) {
                let ip = data.Addresses[key];
                IFC2.log('Found IF on: ' + ip, IFC2.INFO);
                if (ip.match(regex)) {
                    // only match IPv4 addresses for now
                    IFC2.infiniteFlight.serverAddress = ip;
                }
            }
            server.close();

            IFC2.preConnect();
        });

        // When udp server started and listening.
        server.on('listening', function () {
            // Get and print udp server listening ip address and port number in log console.
            let address = server.address();
            IFC2.log(
                'UDP Server started and listening on ' +
                    address.address +
                    ':' +
                    address.port,
                IFC2.INFO
            );
        });
    },

    /*****
     * Close active connections
     */
    close: function (callback) {
        // Only close if connected
        if (IFC2.isConnected) {
            // Reset isConnected flag
            IFC2.isConnected = false;

            // Reset the sucess callback function
            IFC2.successCallback = () => {};

            // Destroy client socket
            IFC2.infiniteFlight.clientSocket.destroy();
            IFC2.infiniteFlight.clientSocket.emit(
                'error',
                new Error('ECONNRESET')
            );

            // Delete client socket
            delete IFC2.infiniteFlight.clientSocket;

            // Recreate client socket
            IFC2.infiniteFlight.clientSocket = new net.Socket();

            // Destory poll socket
            IFC2.infiniteFlight.pollSocket.destroy();
            IFC2.infiniteFlight.pollSocket.emit(
                'error',
                new Error('ECONNRESET')
            );

            // Delete poll socket
            delete IFC2.infiniteFlight.pollSocket;

            // Recreate poll socket
            IFC2.infiniteFlight.pollSocket = new net.Socket();

            // Destory poll socket
            IFC2.infiniteFlight.manifestSocket.destroy();
            IFC2.infiniteFlight.manifestSocket.emit(
                'error',
                new Error('ECONNRESET')
            );

            // Delete manifest socket
            delete IFC2.infiniteFlight.manifestSocket;

            // Recreate manifest socket
            IFC2.infiniteFlight.manifestSocket = new net.Socket();

            // Reset manfiest data
            IFC2.infiniteFlight.manifestData = ''; // String to hold raw manifest data
            (IFC2.infiniteFlight.manifestByName = {}), // Object to hold the manifest organised by command name
                (IFC2.infiniteFlight.manifestByCommand = {}); // Object to hold the manifest organised by command number
            IFC2.infiniteFlight.manifestLength = 0; // Manifest length -- zero is initial placeholder
            IFC2.infiniteFlight.manifestBuffer = null; // Placeholder variable for future manifest buffer

            // Reset isWaiting flag
            IFC2.isWaiting = false;

            // Reset queues
            IFC2.q = [];
            IFC2.pollQ = [];

            // Reset wait list
            IFC2.waitList = [];

            // Reset ifData data object
            IFC2.ifData = {};
        }

        // Execute callback function
        callback();
    },
};

module.exports = IFC2;
