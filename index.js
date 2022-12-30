const IFC2 = require('./ifc2');
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let manifest = {};

IFC2.on('IFC2manifest', function (m) {
    manifest = Object.keys(m)
        .sort()
        .reduce((obj, key) => {
            obj[key] = m[key];
            return obj;
        }, {});
});

process.on('exit', () => console.log('Goodbye'));

(async () => {
    console.log('Intializing...');
    await new Promise((res) =>
        IFC2.init(res, {
            callback: true,
        })
    );
    console.log('Ready');
    console.log('');
    while (true) {
        const input = await new Promise((res) => rl.question('>> ', res));
        if (input === 'exit') {
            process.exit(0);
        }
        const parts = input.split(' ');
        if (parts.length === 0) {
            continue;
        }

        try {
            if (parts.length === 1) {
                if (parts[0].startsWith('commands/')) {
                    const command = manifest[parts[0]];
                    if (!command) {
                        console.log('Error: Unknown command');
                        continue;
                    }

                    IFC2.run(parts[0]);
                } else if (parts[0].toLowerCase() == 'reconnect') {
                    await new Promise((res) => IFC2.close(res));
                    console.log('Old Connection Closed');
                    await new Promise((res) =>
                        IFC2.init(res, {
                            callback: true,
                        })
                    );
                    console.log('New Connection Established');
                    console.log('Ready');
                    console.log('');
                } else {
                    const command = manifest[parts[0]];
                    if (!command) {
                        console.log('Error: Unknown command');
                        continue;
                    }

                    const res = await new Promise((res) =>
                        IFC2.get(parts[0], res)
                    );
                    console.log(res.data);
                }
            } else if (parts.length === 2) {
                if (parts[0] === 'manifest') {
                    console.log(
                        Object.keys(manifest)
                            .filter((x) =>
                                x.toLowerCase().includes(parts[1].toLowerCase())
                            )
                            .join('\n')
                    );
                    continue;
                }

                const command = manifest[parts[0]];
                if (!command) {
                    console.log('Error: Unknown command');
                    continue;
                }
                let value = parts[1];
                switch (command.type) {
                    case 0: // boolean
                        value = value === 'true' || value === '1';
                        break;
                    case 1: // integer
                        value = parseInt(value);
                        break;
                    case 2: // float
                        value = parseFloat(value);
                        break;
                    case 3: // double
                        value = parseFloat(value);
                        break;
                    case 4: // string
                        break;
                    case 5: // long
                        value = parseInt(value);
                        break;
                    case -1: // command
                        const [name, val] = value.split(':');
                        if (name === undefined || val === undefined) {
                            if (!value) {
                                console.log('Error: Invalid argument');
                                continue;
                            }

                            IFC2.run(parts[0], [{ name: 'x', value }]);
                            continue;
                        }

                        IFC2.run(parts[0], [{ name, value: val }]);
                        continue;
                    default:
                        console.log('Error: Unknown type');
                        continue;
                }

                IFC2.set(parts[0], value);
            } else {
                const command = manifest[parts[0]];
                if (!command) {
                    console.log('Error: Unknown command');
                    continue;
                }
                if (command.type !== -1) {
                    console.log('Error: Command does not accept arguments');
                    continue;
                }

                const args = parts
                    .slice(1)
                    .map((x, i) => {
                        const [name, value] = x.split(':');
                        if (name === undefined || value === undefined) {
                            if (!x) {
                                console.log('Error: Invalid argument');
                                return undefined;
                            }

                            return { name: `x${i}`, value: x };
                        }
                        return { name, value };
                    })
                    .filter((x) => x !== undefined);

                IFC2.run(parts[0], args);
            }
        } catch (e) {
            console.log(e.stack);
        }
    }
})();
