/*
 Require dependencies
 */
var vec3 = require('gl-vec3');
var vec2 = require('gl-vec2');
var clamp = require('clamp');
var dt = require("./data_types.js");

var SpatialHash = require("./spatial_hash.js");
var createRenderer = require("./renderer.js");
var toPixel = require("./renderer.js").toPixel;

function Capsule(p0, p1, radius, color) {

    this.p0 = vec2.fromValues(p0[0] * WORLD_SCALE, p0[1] * WORLD_SCALE);
    this.p1 = vec2.fromValues(p1[0] * WORLD_SCALE, p1[1] * WORLD_SCALE);

    this.radius = radius * WORLD_SCALE;
    this.color = color;
}

function Particle(position, velocity, color) {

    this.position = vec2.fromValues(position[0] * WORLD_SCALE, position[1] * WORLD_SCALE);

    this.velocity = vec2.fromValues(velocity[0] * WORLD_SCALE, velocity[1] * WORLD_SCALE);

    // console.log("add part: ", this.position );
    this.color = color;

    this.radius = particleRadius;

    this.o = [this.position[0], this.position[1]];
    this.f = [0.0, 0.0];
    this.isNew = true;
}

// evaluate the implicit function of the capsule on the coordinate x.
// return positive number if x is outside the capsule
// return negative number if x is inside the capsule
// return zero if x is exactly on the border.
Capsule.prototype.eval = function (x) {
    var scratch = [0.0, 0.0];
    var p0 = this.p0;
    var p1 = this.p1;
    var r = this.radius;

    var p1_sub_p0 = [0.0, 0.0];
    vec2.subtract(p1_sub_p0, p1, p0);

    var t = -vec2.dot(vec2.subtract(scratch, p0, x), p1_sub_p0) / vec2.dot(p1_sub_p0, p1_sub_p0);
    t = clamp(t, 0.0, 1.0);

    var q = [0.0, 0.0];
    vec2.scaleAndAdd(q, p0, p1_sub_p0, t);

    var Fx = vec2.length(vec2.subtract(scratch, q, x)) - r;
    return Fx;
}


/*
 If, for instance, frequency=0.1, that means we emit every 100th millisecond. So ten times per second.
 */
function Emitter(position, frequency) {
    this.position = position;
    this.frequency = {val: 0.05};
    this.timer = 0.0;
    this.radius = 0.015;
    this.color = [0.0, 0.0, 1.0];


    this.baseAngle = {val: 70};
    this.angleVelocity = {val: 0};
    this.angle = {val: 0};


    this.strength = {val: 0.006};
    this.velRand = {val: 2};
}

Emitter.prototype.eval = function (x) {

    var o = this.position;
    var r = this.radius;

    var o_minus_x = [0.0, 0.0];
    vec2.subtract(o_minus_x, o, x);

    return vec2.length(o_minus_x) - r;
}

// this is the min and max points of the simulation world.
var WORLD_MIN = [-0.6, -0.6];
var WORLD_MAX = [+0.6, +0.9];

// however, we scale the entire simulation world by WORLD_SCALE, in order to make
// sure that it doesn't run too fast.
var WORLD_SCALE = dt.WORLD_SCALE;
var SCALED_WORLD_MIN = [WORLD_MIN[0] * WORLD_SCALE, WORLD_MIN[1] * WORLD_SCALE];
var SCALED_WORLD_MAX = [WORLD_MAX[0] * WORLD_SCALE, WORLD_MAX[1] * WORLD_SCALE];

var particleRadius = 0.015 * WORLD_SCALE;
var h = particleRadius; // support radius

const CAPSULE_COLOR = [0, 0.5, 0];

var gravity = +0.03; // gravity force.
var sigma = 0.9;
var beta = 0.3;

// how much of its original velocity that a particle gets to keep when it bounces against a capsule.
var collisionDamping = 1.0 / 5.0;

// see the paper for definitions of these.
const restDensity = 10.0;
const stiffness = 0.009;
const nearStiffness = 1.2;


/*
 Constructor
 */
function Simulation(gl) {

    this.particles = [];

    this.renderer = new createRenderer(gl);

    // used when we are adding a new capsule in the GUI.
    this.newCapsule = null;

    this.collisionBodies = [];
    this.emitters = [];
    
    // frame
    const CAPSULE_RADIUS = 0.03;
    const FRAME_RADIUS = 0.06;
    this.collisionBodies.push(new Capsule(WORLD_MIN, [WORLD_MAX[0], WORLD_MIN[1]], FRAME_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule([WORLD_MIN[0] * 0.7, WORLD_MAX[1]], [WORLD_MAX[0], WORLD_MAX[1]], FRAME_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule(WORLD_MIN, [WORLD_MIN[0], WORLD_MAX[1]], FRAME_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule([WORLD_MAX[0], WORLD_MIN[1]], WORLD_MAX, FRAME_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule([0.1, 0.8], [0.3, 0.5], CAPSULE_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule([0.6, 0.0], [0.3, 0.3], CAPSULE_RADIUS, CAPSULE_COLOR));
    this.collisionBodies.push(new Capsule([-0.5, -0.3], [0.2, 0.4], CAPSULE_RADIUS, CAPSULE_COLOR));

    this.emitters.push(new Emitter([-0.1, -0.15]));

    this.hash = new SpatialHash(h, SCALED_WORLD_MIN, SCALED_WORLD_MAX);

    this.isLimitParticles = {val: true};
    this.maxParticles = {val: 1500};
}


function getRandomArbitrary(min, max) {
    return Math.random() * (max - min) + min;
}


var timeCount = 0;

Simulation.prototype.reset = function () {
    this.particles = [];
}

Simulation.prototype.update = function (canvasWidth, canvasHeight, mousePos, delta) {

    if (this.newCapsule != null) {
        // when adding a new capsule, make p1 of the capsule follow the mouse.
        this.newCapsule.p1 = this.mapMousePos(mousePos);
    }

    this.renderer.update(canvasWidth, canvasHeight);
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;

    /*
    Below, we implement the water simulation. It is based on the paper
    "Particle-based Viscoelastic Fluid Simulation"
     http://www.ligum.umontreal.ca/Clavet-2005-PVFS/pvfs.pdf
     */

    this.emitParticles(delta);
    this.removeOutOfBoundsParticles();

    this.hash.update(this.particles);

    for (var i = 0; i < this.particles.length; ++i) {
        var iParticle = this.particles[i];

        vec2.add(iParticle.position, iParticle.position, iParticle.f);
        iParticle.f = [0.0, 0.0];

        iParticle.nearDensity = 0.0;
        iParticle.density = 0.0;

        if (!iParticle.isNew) {
            /*
            To compute the position, we use the prediction-relaxation scheme described in the paper:
             */
            vec2.subtract(iParticle.velocity, iParticle.position, iParticle.o);
            vec2.scale(iParticle.velocity, iParticle.velocity, 1.0 / 1.0);
        }

        iParticle.isNew = false;

        iParticle.velocity[1] += gravity * 1.0;

        // do viscosity impules(algorithm 5 from the paper)
        this.doViscosityImpules(iParticle, 1.0);
    }

    for (var i = 0; i < this.particles.length; ++i) {

        var iParticle = this.particles[i];

        // save the original particle position.
        iParticle.o = [iParticle.position[0], iParticle.position[1]];
        vec2.add(iParticle.position, iParticle.position, iParticle.velocity);

        // compute near and far density from the paper.
        this.computeDensities(iParticle);

        // handle collision with capsules.
        this.handleCollision(iParticle);

    }

    // below we do double density relaxation(algorithm 2 in the paper)
    this.doubleDensityRelaxation(1.0);
}

Simulation.prototype.doViscosityImpules = function(iParticle, delta) {

    var nearParticles = this.hash.getNearParticles(iParticle);
    for (var j = 0; j < nearParticles.length; ++j) {
        var jParticle = nearParticles[j];

        var dp = [0.0, 0.0];
        vec2.subtract(dp, iParticle.position, jParticle.position);

        var r2 = vec2.dot(dp, dp);

        if (r2 <= 0.0 || r2 > h * h)
            continue;

        var r = Math.sqrt(r2);

        var normalized_r = [0.0, 0.0];
        vec2.scale(normalized_r, dp, 1.0 / r);

        var one_minus_q = 1 - r / h;

        var vi_minus_vj = [0.0, 0.0];
        vec2.subtract(vi_minus_vj, iParticle.velocity, jParticle.velocity);

        var u = vec2.dot(vi_minus_vj, normalized_r);

        var T = 0;
        if (u > 0) {
            T = delta * one_minus_q * (sigma * u + beta * u * u) * 0.5;
            if (T < u) {
                T = T;
            } else {
                T = u;
            }
        } else {
            T = delta * one_minus_q * (sigma * u - beta * u * u) * 0.5;
            if (T > u) {
                T = T;
            } else {
                T = u;
            }
        }

        var I_div2 = [0.0, 0.0];
        vec2.scale(I_div2, normalized_r, T);

        vec2.scaleAndAdd(iParticle.velocity, iParticle.velocity, I_div2, -1.0);
        vec2.scaleAndAdd(jParticle.velocity, jParticle.velocity, I_div2, +1.0);

    }
}


Simulation.prototype.computeDensities = function(iParticle) {

    var nearParticles = this.hash.getNearParticles(iParticle);
    for (var j = 0; j < nearParticles.length; ++j) {

        var jParticle = nearParticles[j];

        var dp = [0.0, 0.0];

        vec2.subtract(dp, iParticle.position, jParticle.position);

        var r2 = vec2.dot(dp, dp);

        if (r2 <= 0.0 || r2 > h * h)
            continue;

        var r = Math.sqrt(r2);
        var a = 1 - r / h;

        var aa = a * a;
        var aaa = aa * a;

        iParticle.density += aa;
        jParticle.density += aa;

        iParticle.nearDensity += aaa;
        jParticle.nearDensity += aaa;
    }
}

Simulation.prototype.removeOutOfBoundsParticles = function() {
    for (var i = 0; i < this.particles.length; ++i) {
        var iParticle = this.particles[i];
        var p = iParticle.position;
        if (p[0] < SCALED_WORLD_MIN[0] || p[1] < SCALED_WORLD_MIN[1] ||
            p[0] > SCALED_WORLD_MAX[0] || p[1] > SCALED_WORLD_MAX[1]) {
            this.particles.splice(i, 1);
            --i;
        }
    }
}

Simulation.prototype.emitParticles = function(delta) {

    for (var i = 0; i < this.emitters.length; ++i) {
        var emitter = this.emitters[i];

        emitter.timer += delta;

        // console.log("timer: ",  emitter.timer, emitter.frequency );

        if (emitter.timer > emitter.frequency.val && (!this.isLimitParticles.val || (this.particles.length < this.maxParticles.val))) {

            var c = [emitter.color[0], emitter.color[1], emitter.color[2]];

            if (emitter.angleVelocity.val == 0) {
                emitter.angle.val = emitter.baseAngle.val;
            } else {
                emitter.angle.val += emitter.angleVelocity.val;
            }


            var theta = emitter.angle.val * (Math.PI / 180.0);
            theta = Math.PI * 2 - theta;

            emitter.angle.val += emitter.angleVelocity.val;

            const strength = emitter.strength.val;
            const velocity = [strength * Math.cos(theta), strength * Math.sin(theta)];

            const v = [-velocity[1], velocity[0]];

            var c = [emitter.color[0], emitter.color[1], emitter.color[2]];

            var a = emitter.velRand.val * 0.0001;

            for (var j = -1; j <= 1; ++j) {
                var p = [0.0, 0.0];

                vec2.scaleAndAdd(p, emitter.position, v, 0.8 * (j));

                this.particles.push(new Particle(
                    p, [velocity[0] + getRandomArbitrary(-a, a), velocity[1] + getRandomArbitrary(-a, a)],

                    c
                ));
            }

            emitter.timer = 0.0;
        }
    }
}


Simulation.prototype.handleCollision = function(iParticle) {

    // for iParticle, handle collision with all the capsules.
    // to do the collision checking, we are representing the capsules as implicit functions.
    // we are using the formulas derived in section 4.4.2.2 of the paper
    // "Lagrangian Fluid Dynamics Using Smoothed Particle Hydrodynamics"
    // http://image.diku.dk/projects/media/kelager.06.pdf#page=33

    for (var iBody = 0; iBody < this.collisionBodies.length; ++iBody) {

        var body = this.collisionBodies[iBody];

        var x = iParticle.position;
        var scratch = vec2.create();

        if (true) {
            var p0 = body.p0;
            var p1 = body.p1;
            var r = body.radius;

            var p1_sub_p0 = [0.0, 0.0];
            vec2.subtract(p1_sub_p0, p1, p0);

            var t = -vec2.dot(vec2.subtract(scratch, p0, x), p1_sub_p0) / vec2.dot(p1_sub_p0, p1_sub_p0);
            t = clamp(t, 0.0, 1.0);

            var q = [0.0, 0.0];
            vec2.scaleAndAdd(q, p0, p1_sub_p0, t);

            var Fx = vec2.length(vec2.subtract(scratch, q, x)) - r;

            // check if collision
            if (Fx <= 0) {

                var x_sub_q = [0.0, 0.0];
                vec2.subtract(x_sub_q, x, q);
                var x_sub_q_len = vec2.length(x_sub_q);

                // compute normal.
                var n = [0.0, 0.0];
                vec2.scale(n, x_sub_q, -Math.sign(Fx) / ( x_sub_q_len  ))

                // bounce particle in the direction of the normal.
                vec2.scaleAndAdd(iParticle.position, iParticle.position, n, -Fx * collisionDamping);
            }
        }
    }
}


Simulation.prototype.doubleDensityRelaxation = function (delta) {

    for (var i = 0; i < this.particles.length; ++i) {

        var iParticle = this.particles[i];

        var pressure = stiffness * (iParticle.density - restDensity);
        var nearPressure = nearStiffness * iParticle.nearDensity;

        var nearParticles = this.hash.getNearParticles(iParticle);
        for (var j = 0; j < nearParticles.length; ++j) {
            var jParticle = nearParticles[j];

            var dp = [0.0, 0.0];
            vec2.subtract(dp, iParticle.position, jParticle.position);
            var r2 = vec2.dot(dp, dp);

            if (r2 <= 0.0 || r2 > h * h)
                continue;

            var r = Math.sqrt(r2);
            var a = 1 - r / h;

            var D = delta*delta*( pressure * a + nearPressure * a * a ) * 0.5;
            var DA = [0.0, 0.0];
            vec2.scale(DA, dp, D / r);
            vec2.scaleAndAdd(iParticle.f, iParticle.f, DA, 1.0);
            vec2.scaleAndAdd(jParticle.f, jParticle.f, DA, -1.0);
        }
    }

}

Simulation.prototype.draw = function (gl) {
    this.renderer.draw(gl, this.collisionBodies, this.particles, this.newCapsule, this.emitters);
}

Simulation.prototype.mapMousePos = function (mousePos) {

    // below we map the mouse pos(in pixel coordinates) to the coordinate system of the water simultation
    return [
        WORLD_SCALE * (mousePos[0] - ( this.canvasWidth - this.canvasHeight ) * 0.5 - 0.5 * this.canvasHeight) * (  2.0 / this.canvasHeight ),
        (-1 + 2 * (  mousePos[1] / this.canvasHeight )) * WORLD_SCALE,

    ];
}

// return the minimum pixel position of the simulation.
Simulation.prototype.getMinPos = function () {
    var x = ((WORLD_MIN[0] + 1) / 2.0) * this.canvasHeight + (this.canvasWidth - this.canvasHeight) / 2.0;
    var y = this.canvasHeight - (((WORLD_MAX[1] + 1) / 2.0) * this.canvasHeight);
    return [x, y];
}

// return the minimum pixel position of the simulation.
Simulation.prototype.getMaxPos = function () {
    var x = ((WORLD_MAX[0] + 1) / 2.0) * this.canvasHeight + (this.canvasWidth - this.canvasHeight) / 2.0;
    var y = this.canvasHeight - (((WORLD_MIN[1] + 1) / 2.0) * this.canvasHeight);
    return [x, y];
}

// remove capsule, if we are hovering over one.
Simulation.prototype.removeCapsule = function (mousePos) {
    var mMousePos = this.mapMousePos(mousePos);

    for (var iBody = 0; iBody < this.collisionBodies.length; ++iBody) {

        var body = this.collisionBodies[iBody];

        var Fx = body.eval(mMousePos);

        if (Fx <= 0) {
            this.collisionBodies.splice(iBody, 1);
            --iBody;
        }
    }
}

// in the first call of addCapsule, set p0 of capsule
// in the second call, set p1
Simulation.prototype.addCapsule = function (mousePos, capsuleRadius) {

    if (this.newCapsule != null) {
        // add the capsule.
        this.collisionBodies.push(this.newCapsule);
        this.newCapsule = null;
    } else {
        // make new capsule.
        var mMousePos = this.mapMousePos(mousePos);
        this.newCapsule = new Capsule([mMousePos[0] / WORLD_SCALE, mMousePos[1] / WORLD_SCALE], [0.0, 0.0], capsuleRadius, CAPSULE_COLOR);

        this.newCapsule.p1 = this.mapMousePos(mousePos);
    }

}

Simulation.prototype.addEmitter = function (mousePos) {
    var mMousePos = this.mapMousePos(mousePos);
    this.emitters.push(new Emitter([mMousePos[0] / WORLD_SCALE, mMousePos[1] / WORLD_SCALE]));
}

// return index of emitter under the cursor.
Simulation.prototype.findEmitter = function (mousePos) {

    var mMousePos = this.mapMousePos(mousePos);

    for (var i = 0; i < this.emitters.length; ++i) {
        var emitter = this.emitters[i];
        var Fx = emitter.eval([mMousePos[0] / WORLD_SCALE, mMousePos[1] / WORLD_SCALE]);
        if (Fx <= 0) {
            return i;
        }
    }

    return -1;
}


Simulation.prototype.removeEmitter = function (mousePos) {
    var i = this.findEmitter(mousePos);
    if (i != -1) {
        this.emitters.splice(i, 1);
    }
}

Simulation.prototype.selectEmitter = function (mousePos) {
    var i = this.findEmitter(mousePos);
    if (i != -1) {
        return this.emitters[i]
    } else {
        return null;
    }
}

Simulation.prototype.cancelAddCapsule = function () {
    this.newCapsule = null;
}

module.exports = Simulation;

/*
 http://prideout.net/blog/?p=58

 3D SPH rendering:
 http://developer.download.nvidia.com/presentations/2010/gdc/Direct3D_Effects.pdf


 GPU gems 2D fluids:
 http://meatfighter.com/fluiddynamics/GPU_Gems_Chapter_38.pdf


 SPH Study for integration in games:
 http://www.roelezendam.com/Specialisation%20Thesis%20Final%20Roel%20Ezendam%20070254.pdf

 Original SPH article:
 http://matthias-mueller-fischer.ch/publications/sca03.pdf

 Siggraph course:
 file:///Users/eric/Dropbox/backlog/fluids_notes.pdf

 Japanese SPH article:
 http://inf.ufrgs.br/cgi2007/cd_cgi/papers/harada.pdf

 SPH and euler tutorial:
 http://cg.informatik.uni-freiburg.de/intern/seminar/gridFluids_fluid-EulerParticle.pdf

 Fluid flow for the rest of us:
 http://cg.informatik.uni-freiburg.de/intern/seminar/gridFluids_fluid_flow_for_the_rest_of_us.pdf

 5.6.1

 create n particles.
 create collision objects.
 initialize leap-frog integrator.(but initially, we may as well use
 newton. )



 5.6.4
 compute g force.



 5.6.5

 F = f_internal + f_external
 but it in will only be the g force, in our simplified case.

 use leap-frog to advance particle velocity and position.


 Perform collision detection against collision primitives using (4.33).
 v. If a collision occurred then
 a. Project particle position according to the contact point using (4.55).
 b. Update the velocity using (4.58).
 vi. Approximate the new particle velocity using


 optimizeize v8:
 https://www.youtube.com/watch?v=UJPdhx5zTaw
 http://thibaultlaurens.github.io/javascript/2013/04/29/how-the-v8-engine-works/

 masters thesis:
 http://image.diku.dk/projects/media/kelager.06.pdf

 */