// cupcat/antigravity.js — Clean offline stub (no network model downloads)
let segmenter = null;

export async function initAntigravityModel() {
    return null;
}

export async function getSegmentationMask(source) {
    return null;
}

/**
 * Particle Engine for the Antigravity effect.
 * Generates floating debris/rocks that fly upwards.
 */
export class ParticleEngine {
    constructor() {
        this.particles = [];
        this.lastTime = performance.now();
        this.active = false;
    }

    activate() {
        if (!this.active) {
            this.active = true;
            this.lastTime = performance.now();
            this.particles = [];
        }
    }

    deactivate() {
        this.active = false;
        this.particles = [];
    }

    update(w, h) {
        if (!this.active) return;
        const now = performance.now();
        const dt = Math.min((now - this.lastTime) / 1000, 0.1);
        this.lastTime = now;

        // Spawn new particles
        if (this.particles.length < 50 && Math.random() < 0.3) {
            this.particles.push({
                x: Math.random() * w,
                y: h + 50, // Start slightly below screen
                vx: (Math.random() - 0.5) * 50,
                vy: -50 - Math.random() * 100, // Negative velocity (flying up)
                size: 2 + Math.random() * 8,
                color: `rgba(200, 200, 220, ${0.4 + Math.random() * 0.4})`,
                life: 0,
                maxLife: 3 + Math.random() * 4,
                rotation: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * 2
            });
        }

        // Update existing particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            
            // Antigravity physics (acceleration upwards)
            p.vy -= 100 * dt; 
            
            // Turbulence drift
            p.x += (p.vx + Math.sin(p.life * 3 + p.y) * 20) * dt;
            p.y += p.vy * dt;
            p.rotation += p.rotSpeed * dt;
            p.life += dt;

            if (p.life >= p.maxLife || p.y < -100) {
                this.particles.splice(i, 1);
            }
        }
    }

    draw(ctx, w, h) {
        if (!this.active) return;
        this.update(w, h);

        ctx.save();
        for (const p of this.particles) {
            ctx.fillStyle = p.color;
            
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            
            // Draw irregular rock shape
            ctx.beginPath();
            ctx.moveTo(0, -p.size);
            ctx.lineTo(p.size, -p.size/2);
            ctx.lineTo(p.size/2, p.size);
            ctx.lineTo(-p.size/2, p.size);
            ctx.lineTo(-p.size, 0);
            ctx.closePath();
            ctx.fill();
            
            ctx.rotate(-p.rotation);
            ctx.translate(-p.x, -p.y);
        }
        ctx.restore();
    }
}

export const particleEngine = new ParticleEngine();
