# ifconnect-shell

A simple Node.js command line tool for interacting with the Infinite Flight Connect API v2.

## Available Commands

### `help`

Displays a list of available commands.

### `exit`

Exits the program.

### `reconnect`

Reconnects to the Infinite Flight Connect API.

### `manifest [searchterm]`

Searches the command and state manifest for the given term.

### `[state]`

Simply type the path of a state to get its value.

### `[state] [value]`

Type the path of a state followed by a value to set the state.

### `[command] [...args]`

Type the path of a command followed by zero or more arguments to execute the command.