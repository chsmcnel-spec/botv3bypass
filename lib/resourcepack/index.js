'use strict'
const { ResourcePack } = require('./manager')
const routes = require('./routes')

function createResourcePack(opts) {
  const rp = new ResourcePack(opts)
  rp.install = (app, o) => routes.install(app, rp, o)
  return rp
}
module.exports = { createResourcePack, ResourcePack }
