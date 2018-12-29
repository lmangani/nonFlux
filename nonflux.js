/*
 * ClickFlux DB
 * InfluxDB to Clickhouse Gateway
 * (C) 2018-2019 QXIP BV
 * Some Rights Reserved.
 */

var debug = process.env.DEBUG || false;
var exception = process.env.EXCEPTION || false;
var tsDivide = process.env.TSDIVIDE || 1000000000;

/* DB Helper */
const ifqlparser = require('ifql-parser')();
const lineParser = require('./lineparser');
const ClickHouse = require('@apla/clickhouse');

const clickhouse_options = {
    host: process.env.CLICKHOUSE_SERVER || 'localhost',
    port: process.env.CLICKHOUSE_PORT || 8123,
    queryOptions: { database: process.env.CLICKHOUSE_DB || 'default' }
};
var clickhouse = new ClickHouse(clickhouse_options);
var ch = new ClickHouse(clickhouse_options);

/* Response Helpers */
var resp_empty = {"results":[{"statement_id":0}]};

/* Cache Helper */
var recordCache = require('record-cache');
var onStale = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO "+key+"(fingerprint, timestamp_ms, value, string)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR METRIC BULK',err);
	       if (debug) console.log ('Insert Samples complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}
var onStale_labels = function(data){
 	for (let [key, value] of data.records.entries()) {
	     var statement = "INSERT INTO time_series(date, fingerprint, measurement, name, labelname, labelvalue, labels)";
   	     ch = new ClickHouse(clickhouse_options);
	     var clickStream = ch.query (statement, {inputFormat: 'TSV'}, function (err) {
	       if (err) console.log('ERROR LABEL BULK',err);
	       if (debug) console.log ('Insert Labels complete for',key);
	     });
 	     value.list.forEach(function(row){
		if (!row.record) return;
		clickStream.write ( row.record );
             });
	     clickStream.end ();
        }
}

// Flushing to Clickhouse
var bulk = recordCache({
  maxSize: 5000,
  maxAge: 2000,
  onStale: onStale
})
var bulk_labels = recordCache({
  maxSize: 100,
  maxAge: 500,
  onStale: onStale_labels
})
// In-Memory LRU for quick lookups
var labels = recordCache({
  maxSize: 50000,
  maxAge: 0,
  onStale: false
})

/* Fingerprinting */
var shortHash = require("short-hash")
var fingerPrint = function(text,hex){
	if (hex) return shortHash(text);
	else return parseInt(shortHash(text), 16);
}

/* Function Helpers */
var labelParser = function(labels){
	// Label Parser
	var rx = /\"?\b(\w+)\"?(!?=~?)("[^"\n]*?")/g;
	var matches, output = [];
	while (matches = rx.exec(labels)) {
	    if(matches.length >3) output.push([matches[1],matches[2],matches[3].replace(/['"]+/g, '')]);
	}
	return output;
}

var databaseName;
var getTableQuery = function(dbName,tableName){
	return "CREATE TABLE "+tableName+"( fingerprint UInt64,  timestamp_ms Int64,  value Float64,  string String) ENGINE = MergeTree PARTITION BY toRelativeHourNum(toDateTime(timestamp_ms / 1000)) ORDER BY (fingerprint, timestamp_ms)"
}
var getSeriesTableName = function(tableName){
}
var initializeTimeseries = function(dbName){
	console.log('Initializing TS DB...',dbName);
	var dbQuery = "CREATE DATABASE IF NOT EXISTS "+dbName;
	clickhouse.query(dbQuery, function (err, data) {
		if (err) console.error(err);
		databaseName = dbName;
		clickhouse_options.queryOptions.database = dbName;
		var tmp = new ClickHouse(clickhouse_options);
		var qquery =  "CREATE TABLE "+dbName+".time_series ( date Date,  fingerprint UInt64,  measurement String,  name String,  labelname Array(String),  labelvalue Array(String),  labels String) ENGINE = ReplacingMergeTree PARTITION BY date ORDER BY fingerprint"
	  	tmp.query(qquery, function(err,data){
			if (err) return err;
			if (debug) console.log('TimeSeries Table ready!');
			return true;
		});
	});
}

var databaseCache = [];
var initialize = function(dbName,tableName){
	console.log('Initializing DB...',dbName,tableName);
	if (!dbName||databaseCache[dbName]) return;
	var dbQuery = "CREATE DATABASE IF NOT EXISTS "+dbName;
	clickhouse.query(dbQuery, function (err, data) {
		if (err) { console.error('ERROR CREATING DATABASE!',dbQuery,err); return; }
		databaseName = dbName;
		databaseCache.push(dbName);
		if(tableName){
			clickhouse_options.queryOptions.database = dbName;
			var tmp = new ClickHouse(clickhouse_options);
	  		tmp.query(getTableQuery(dbName,tableName), function(err,data){
				if (err) { console.err(getTableQuery(dbName,tableName),err); return; }
				if (debug) console.log('Table ready!',tableName);
				return true;
			});
			reloadFingerprints();
			initializeTimeseries(dbName);
		}
	});
}

// Initialize
// initialize('superloki','samples');

var reloadFingerprints = function(){
  console.log('Reloading Fingerprints...');
  var select_query = "SELECT DISTINCT fingerprint, labels FROM time_series";
  var stream = ch.query(select_query);
  // or collect records yourself
	var rows = [];
	stream.on ('metadata', function (columns) {
	  // do something with column list
	});
	stream.on ('data', function (row) {
	  // TODO: handler error
	  rows.push (row);
	});
	stream.on ('error', function (err) {
	  // TODO: handler error
	});
	stream.on ('end', function () {
	  rows.forEach(function(row){
	    try {
	      var JSON_labels = JSON.parse(row[1])[0];
	      labels.add(row[0],JSON.stringify(JSON_labels));
	  	for (var key in JSON_labels){
			// if (debug) console.log('Adding key',key,row);
			labels.add(key,row[1]);
			labels.add(row[0],1);
	  	};
	    } catch(e) {}
	  });
	  if (debug) console.log('Reloaded fingerprints:',rows.length+1);
	});
}

/* Functions */

/* Function Helpers */
var createTable = function(dbName,tableName){
	if (!tableName||!dbName) return;
	return getTableQuery(dbName,tableName);
};

var tables = [];
var getTables = function(dbName){
	var showTables = "show tables";
	clickhouse_options.queryOptions.database = dbName;
  	ch = new ClickHouse(clickhouse_options);
	var stream = clickhouse.query(showTables);
	stream.on ('data', function (row) {
	  if (tables.indexOf(row[0]) === -1) tables.push (row[0]);
	});
	stream.on ('error', function (err) {
		// TODO: handler error
		console.log('GET TABLES ERR',err);
		var parsed = err.toString().match(/Table\s(.*) doesn/);
                if (parsed && parsed[1]){
                   console.log('Create Table!',parsed);
                   try {
                       clickhouse.querying(createTable(dbName,parsed[1])).then((result) => console.log(result) )
                       if(res) res.sendStatus(resp_empty);
                   } catch(e) { if (res) res.sendStatus(500) }

                } else {
                        return;
                }
		return false;
	});
	stream.on ('end', function () {
		if (debug) console.log('RELOAD TABLES:',tables);
		return tables;
	});
}

/* HTTP Helper */

var express = require('express')
  , http = require('http')
  , path = require('path')
  , util = require('util');

var app = express();

function rawBody(req, res, next) {
  req.setEncoding('utf8');
  req.rawBody = '';
  req.on('data', function(chunk) {
    req.rawBody += chunk;
  });
  req.on('end', function(){
    next();
  });
}

app.set('port', process.env.PORT || 8686);
app.use(rawBody);

/* Write Handler */

app.post('/write', function(req, res) {
  if (debug) console.log('RAW: ' , req.rawBody);
  if (debug) console.log('QUERY: ', req.query);
  if (!req.query||!req.rawBody) return;

  // Use DB from Query, if any
  if (req.query.db) {
	var dbName = req.query.db;
	if (debug) console.log('DB',dbName )
	initialize(dbName);
  	// Re-Initialize Clickhouse Client
	clickhouse_options.queryOptions.database = dbName;
  	ch = new ClickHouse(clickhouse_options);
  } else { ch =  new ClickHouse(clickhouse_options); }

  var queries = req.rawBody.split("\n");
  queries.forEach(function(rawBody){
	  if (!rawBody || rawBody == '') return;
	  var query = lineParser(rawBody);
	    query.parsed.fields.forEach(function(field){
		for (key in field){
		  var unique = JSON.parse(JSON.stringify(query.parsed.tags)); unique.push({"__name__":key});
		  var uuid = JSON.stringify(unique);
		  var finger = fingerPrint(uuid);
		  if(!labels.get(finger,1)[0]){
		  	bulk_labels.add(finger,[new Date().toISOString().split('T')[0], finger, query.parsed.measurement, key, query.t, query.tv, uuid ]);
			labels.add(finger,key);
		  }

		}
	    });

	  if (query.measurement) table = query.measurement;
	  if (tables.indexOf(query.parsed.measurement) === -1) {
		  console.log('Creating new table...',query.parsed.measurement)
		  try {
			ch.querying(createTable(dbName,query.parsed.measurement))
				.then((result) => sendQuery(query,true) )
			getTables(dbName);
		  } catch(e) { sendQuery(query,true) }
	  } else {
		  sendQuery(query,false);
	  }
  });
  res.sendStatus(204);
});

var sendQuery = function(query,reload){
	  if (debug) console.log(query);
	  query.parsed.fields.forEach(function(field){
		for (key in field){
		  var unique = JSON.parse(JSON.stringify(query.parsed.tags)); unique.push({"__name__":key});
		  var uuid = JSON.stringify(unique);
		  var values = [ parseInt(fingerPrint(uuid)), new Date(query.parsed.timestamp/1000000).getTime(), field[key] || 0, key || "" ];
		  if (debug) console.log('PUSHING SAMPLES',values);
		  bulk.add(query.parsed.measurement, values);
		}
	  })
}


/* INFLUXDB PING EMULATION */
app.get('/ping', (req, res) => {
	if (debug) console.log('PING req!');
	clickhouse.pinging().then((result) => { res.sendStatus(204) } )
})

http.createServer(app).listen(app.get('port'), function(){
  console.log("ClickFlux server listening on port " + app.get('port'));
});


process.on('unhandledRejection', function(err, promise) {
    console.error('Error:',err);
});
