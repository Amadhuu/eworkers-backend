const { Pool } = require("pg");

const pool = new Pool({
  host: "dpg-d42cghi4d50c73et7t90-a.frankfurt-postgres.render.com",
  port: 5432,
  database: "eworkersdb",
  user: "eworkersdb_user",
  password: "KuUESVdOrGUa3WS39qskitxM9NWKPyDV",
  ssl: {
    rejectUnauthorized: false,
  },
});

module.exports = pool;