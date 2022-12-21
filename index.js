const IFC2 = require('ifc2');
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

let manifest = [];

IFC2.on('IFC2manifest', function (m) {
    manifest = Object.keys(m);
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
                    IFC2.run(parts[0]);
                } else {
                    const res = await new Promise((res) =>
                        IFC2.get(parts[0], res)
                    );
                    console.log(res.data);
                }
            } else {
                if (parts[0] === 'manifest') {
                    console.log(
                        manifest
                            .filter((x) =>
                                x.toLowerCase().includes(parts[1].toLowerCase())
                            )
                            .join('\n')
                    );
                }
            }
        } catch {
            console.log('Error');
        }
    }
})();
