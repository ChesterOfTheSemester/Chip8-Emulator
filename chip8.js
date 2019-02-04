/**
 * CHIP-8 Emulator
 * ES6 required
 *
 * By Chester Abrahams
 * CV: https://www.linkedin.com/in/chesterabrahams/
 */

class Chip8
{
    constructor(opt={})
    {
        this.initVM(opt);
        this.initGPU(opt);

        let fn = function()
        {
            if (this.hz > 0)
                for (let i=0; i<10; i++)
                    this.cycle();

            setTimeout(fn, 1000/(this.hz||60))
        }.bind(this);

        fn();
    }

    initVM(opt)
    {
        this.opt = opt;

        this.playing = false;
        this.hz = this.hz || 60; // Clock speed

        /**
         * Memory
         *
         * 0x0-0x200    : IGNORE
         * 0xEA0-0xEFF  : Call stack
         * 0xF00-0xFFF  : Display refresh
         */
        this.RAM = new Uint8Array(0x1000);

        /**
         * Base registers
         */
        this.V = new Uint8Array(16);
        this.VF = 0;
        this.I = 0; // 16B
        this.stack = new Uint16Array(16);
        this.DT = this.ST = 0;

        /**
         * Pseudo registers
         */
        this.PC = 0x200;
        this.SP = 0;
        this.X = this.Y = 0;
        this.N = this.NN = this.NNN = this.NNNN = 0; // Nibbles

        /**
         * Install FONTs
         */
        {
            // 16B fontset
            this.fontSet = [
                0xF999F, 0x26227, 0xF1F8F, 0xF1F1F, // 0, 1, 2, 3
                0x99F11, 0xF8F1F, 0xF8F9F, 0xF1244, // 4, 5, 6, 7
                0xF9F9F, 0xF9F1F, 0xF9F99, 0xE9E9E, // 8, 9, A, B
                0xF888F, 0xE999E, 0xF8F8F, 0xF8F88  // C, D, E, F
            ];

            for (let i=0, C=0; i<this.fontSet.length; i++)
                for (let j=16; j>=0; j-=4, C++)
                    this.RAM[C] = parseInt((this.fontSet[i] >> j & 0xF).toString(16) + "0", 16);
        }

        /**
         * KeyMap
         */
        // Stores keys by 16B hex
        this.keyStates = {};

        // Use JS to convert keystring to keycode
        this.keyMap =
            {
                "1": 0x1, "2": 0x2, "a": 0x9, "s": 0xA,
                "3": 0x3, "4": 0x4, "d": 0xB, "f": 0xC,
                "q": 0x5, "w": 0x6, "j": 0xD, "X": 0xE,
                "e": 0x7, "r": 0x8, "c": 0xF, "V": 0x10
            };

        // Key trigger event
        window.onkeydown = window.onkeyup = (e, i) =>
            (i = this.keyMap[e.key]) &&
            ({
                "keydown" : () => this.keyStates[i] = true,
                "keyup"   : () => delete this.keyStates[i]
            }) [e.type].bind(this)();

        // Beep
        this.audio = document.createElement("audio");
        this.audio.setAttribute("src", "beep.mp3");
    }

    /**
     * Handles graphics (GPU)
     * as well (sound)-timers (SPU)
     */
    initGPU(opt)
    {
        this.canvas = opt.canvas || document.createElement("canvas");
        this.ctx = this.canvas.getContext("2d");
        this.size = opt.size || 4;

        this.canvas.width = this.size*64;
        this.canvas.height = this.size*32;

        /**
         * Original Chip-8 resolution is 64x32
         * Monochrome, so booleans are used
         */
        this.VRAM = new Array(64*32).fill(false);
    }

    cycle()
    {
        this.exec();
        this.xpuCycle();
    }

    /**
     * Draw & decrement timers
     */
    xpuCycle()
    {
        if (this.playing!==true) return false;

        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Redraw pixels according their state
        for (let y=0, C=0; y<32; y++)
            for (let x=0; x<64; x++)
            {
                this.ctx.fillStyle = this.VRAM[C++] ? "#FFFFFF" : "#000000";
                this.ctx.fillRect(
                    this.size*x,
                    this.size*y,
                    this.size,
                    this.size
                );
            }

        // Decrement timers
        if (this.DT>0) this.DT--;
        if (this.ST>0 && this.ST-- && this.ST === 1) this.beep;
    }

    clearScreen()
    {
        for (let i=0; i<this.VRAM.length; i++)
            this.VRAM[i] = false;
    }

    // Flip a pixel to opposite monochrome state
    // Returns true on collision
    flipPixel(x,y)
    {
        this.VRAM[x+64*y] = !this.VRAM[x+64*y];
        return !(this.VRAM[x+64*y] == true);
    }

    /**
     * ROM Loader
     */
    loadROM(URL)
    {
        let xhr = new XMLHttpRequest();
        xhr.open("GET", URL, true);
        xhr.responseType = "arraybuffer";

        xhr.onload = function()
        {
            this.playing = false;
            this.initVM(this.opt);
            let prog = new Uint8Array(xhr.response);

            // Clear RAM
            for (let i=0x200; i<this.RAM.length; i++)
                this.RAM[i] = 0;

            // Insert prog into RAM
            for (let i=0; i<prog.length; i++)
                this.RAM[i+0x200] = prog[i];

            this.clearScreen();
            this.PC = 0x200;
            this.playing = true;
        }.bind(this);

        xhr.send();
    };

    /**
     * Execute a single instruction
     */
    exec()
    {
        if (this.playing!==true) return;

        this.ins = this.ins ||
        {
            0x0000 : () => opcode in this.ins && this.ins[opcode],
            0x8000 : () =>
            {
                let tmp_ins = Object.assign(this.ins,
                    {
                        0x0000 : () => this.V[this.X] = this.V[this.Y], // 0XY0: Vx = Vy
                        0x0007 : () =>                                  // 8XY7 : Vx = Vy, VF = NOT_BORROW
                        {
                            this.VF = +(this.V[this.Y] > this.V[this.X]);
                            this.V[this.X] = this.V[this.Y] - this.V[this.X];
                            if (this.V[this.X] < 0)
                                this.V[this.X] += 0x100;
                        }
                    });

                opcode in tmp_ins && tmp_ins[this.N]();
            },
            0xE000 : () => opcode in this.ins && this.ins[this.NN],
            0xF000 : () => opcode in this.ins && this.ins[this.NN],
            0x000A : () =>                                                                      // Wait for keypress and set Vx
            {
                if (Object.keys(c8.keyStates).length < 1) return;
                this.V[this.X] = c8.keyStates[Object.keys(c8.keyStates)[0]];
            },
            0x00E0 : () => this.clearScreen,                                                    // 00E0: Clear display
            0x00EE : () => this.PC = this.stack[--this.SP],                                     // 00EE: Return subroutine
            0x1000 : () => this.PC = this.NNN,                                                  // 1NNN: Goto NNN
            0x2000 : () => (this.stack[this.SP++%0xC] = this.PC) && (this.PC = this.NNN),       // 2NNN: Call subroutine NNN
            0x3000 : () => this.V[this.X] === this.NN && (this.PC+=2),                           // 3XNN: Skip if Vx == NN
            0x4000 : () => this.V[this.X] !== this.NN && (this.PC+=2),                           // 4XNN: Skip if Vx != NN
            0x5000 : () => this.V[this.X] === this.V[this.Y] && (this.PC+=2),                    // 5XY0: Skip if Vx == Vy
            0x6000 : () => this.V[this.X] = this.NN,                                            // 6XNN: Skip if Vx == NN
            0x7000 : () => this.V[this.X] += this.NN,                                           // 7XNN: Vx += NN
            0x9000 : () => this.V[this.X] !== this.V[this.Y] && (this.PC+=2),                    // 9XY0: Skip if Vx != Vy
            0xA000 : () => this.I = this.NNN,                                                   // ANNN: I = NNN
            0xB000 : () => this.PC = this.NNN + this.V[0],                                      // BNNN: Goto V0 + NNN
            0xC000 : () => this.V[this.X] = Math.round(Math.random() * this.NN) & this.NN,      // CXNN: Vx = random byte & NN
            0xD000 : () =>                                                                      // DXYN: Draw sprite
            {
                this.VF = 0;
                let sprite;

                for (let y=0; y<this.N; y++)
                {
                    sprite = this.RAM[this.I+y];

                    for (let x=0; x<8; x++)
                    {
                        if ((sprite & 0x80) && this.flipPixel(this.V[this.X]+x, this.V[this.Y]+y))
                            this.VF = 1;

                        sprite <<= 1;
                    }
                }
            },
            /** Assign **/
            //0x0000 : () => this.V[this.X] = this.V[this.Y],                                   // 8XY0: Vx = Vy
            0x0001 : () => this.V[this.X] |= this.V[this.Y],                                    // 8XU1: Vx |= Vy
            0x0002 : () => this.V[this.X] &= this.V[this.Y],                                    // 8XY2: Vx &= Vy
            0x0003 : () => this.V[this.X] ^= this.V[this.Y],                                    // 8XY3: Vx ^= Vy
            0x0004 : () =>                                                                      // 8XY4: Vx += Vy, VF = carry | 0
            {
                this.V[this.X] += this.V[this.Y];
                this.VF = +(this.V[this.X] > 0xFF);
                if (this.V[this.X] > 0xFF) this.V[this.X] -= 0x100;
            },
            0x0005 : () =>                                                                      // 8XY5: Vx -= Vy, VF |= borrow
            {
                this.VF = +(this.V[this.X] > this.V[this.Y]);
                this.V[this.X] -= this.V[this.Y];
                if (this.V[this.X] < 0) this.V[this.X] += 256;
            },
            0x0006 : () =>                                                                      // 8XY6: Vx SHR 1
            {
                this.VF = this.V[this.X] & 0x1;
                this.V[this.X] >>= 1;
            },
            0x0007 : () => this.V[this.X] = this.DT,                                            // 8XY7: Vx = Vy - Vx, VF = NOT borrow
            0x000E : () =>                                                                      // 8XYE: Vx = Vx SHL 1
            {
                this.VF = +(this.V[this.X] & 0x80);
                this.V[this.X] <<= 1;
                if (this.V[this.X] > 255)
                    this.V[this.X] -= 256;
            },
            0x009E : () => this.keyStates[this.V[this.X]]  && (this.PC+=2),                     // EX9E: Skip if Vx is pressed
            0x00A1 : () => !this.keyStates[this.V[this.X]] && (this.PC+=2),                     // EXA1: Skip if Vx is NOT pressed
            0x0015 : () => this.DT = this.V[this.X],                                            // FX15: DelayTimer = Vx
            0x0018 : () => this.ST = this.V[this.X],                                            // FX18: SoundTimer = Vx
            0x001E : () => this.I += this.V[this.X],                                            // FX1E" I += Vx
            0x0029 : () => this.I = this.V[this.X] * 5,                                         // FX29: I = sprite location at Dx * number of rows per character
            0x0055 : () => { for (let i=0; i<=this.X; i++) this.RAM[this.I+i] = this.V[i] },    // FX55: Store V0..Vx at RAM[I]
            0x0065 : () => { for (let i=0; i<=this.X; i++) this.V[i] = this.RAM[this.I+i] },    // FX55: Store V0..Vx at RAM[I]
            0x0033 : () =>                                                                      // FX33: Store BCD in RAM[I]
            {
                this.RAM[(this.I+0)&0xFFF] = (this.V[this.X]/100) % 10;
                this.RAM[(this.I+1)&0xFFF] = (this.V[this.X]/10)  % 10;
                this.RAM[(this.I+2)&0xFFF] = this.V[this.X]       % 10;
            },
        };

        let opcode = this.RAM[this.PC] << 8 | this.RAM[this.PC+1];

        this.opcode = opcode;

        this.PC+=2;

        this.N    = opcode & 0xF;            // 4-bit
        this.NN   = opcode & 0xFF;           // 8-bit
        this.NNN  = opcode & 0xFFF;          // 12-bit
        this.NNNN = opcode & 0xFFFF;         // 16-bit
        this.X    = (opcode & 0x0F00) >> 8;  // 4-bit high
        this.Y    = (opcode & 0x00F0) >> 4;  // 4-bit low

        let opc =  (opcode&0xF000) === 0x8000  && this.N  in this.ins && this.N
            || (opcode&0xF000) === 0xE000  && this.NN in this.ins && this.NN
            || (opcode&0xF000) === 0xF000  && this.NN in this.ins && this.NN
            || (opcode&0xF000) === 0x0     && opcode  in this.ins && opcode
            || (opcode&0xF000) in this.ins && (opcode & 0xF000);

        this.instr = opc;

        if (typeof this.ins[opc] != "function")
        {
            this.playing = false;
            throw Error("Undefined opcode: " + (opcode&0xF000).toString(16));
        }
        else
        {
            this.VF = this.V[0xF];
            this.ins[opc]();
            this.V[0xF] = this.VF;

            this.V0 = this.V[0x0];
            this.V1 = this.V[0x1];
            this.V2 = this.V[0x2];
            this.V3 = this.V[0x3];
            this.V4 = this.V[0x4];
            this.V5 = this.V[0x5];
            this.V6 = this.V[0x6];
            this.V7 = this.V[0x7];
            this.V8 = this.V[0x8];
            this.V9 = this.V[0x9];
            this.VA = this.V[0xA];
            this.VB = this.V[0xB];
            this.VC = this.V[0xC];
            this.VD = this.V[0xD];
            this.VE = this.V[0xE];
            this.VF = this.V[0xF];
        }
    }

    get beep() { this.audio.currentTime=0; this.audio.play(); return "BEEP" }
}
