var fs = require('fs');
var path = require('path');
var util = require('util');
var turf = require('turf');
var elasticsearch = require('elasticsearch');
var config = require(process.env.HISTOGRAPH_CONFIG);
var query = require('./query.json');
var client = new elasticsearch.Client({
  host: config.elasticsearch.host + ':' + config.elasticsearch.port
});
var async = require('async');
var _ = require('highland');
require('colors');

var sources = [
  'tgn',
  'bag'
];

function isFunction(functionToCheck) {
 var getType = {};
 return functionToCheck && getType.toString.call(functionToCheck) === '[object Function]';
}

function hasLength(str) {
  return str.length > 0;
}

function infer(data, callback) {
  var rule = data.rule;
  var pit = data.pit;

  var centroid;
  if (pit.geometry) {
    centroid = turf.centroid(pit.geometry).geometry.coordinates;
  }

  query.query.filtered.filter.bool.must = [
    {
      term: {
        type: rule.types.to
      }
    },
    {
      term: {
        sourceid: data.ruleSourceid
      }
    }
  ];

  if (rule.geoDistance) {
    query.query.filtered.filter.bool.must.push({
      geo_shape: {
        geometry: {
          shape: {
            type : 'circle',
            coordinates : centroid,
            radius : util.format('%dm', rule.geoDistance)
          }
        }
      }
    });
  }

  // TODO: alles in rules: of default, of constant, of function(pit)

  var name;
  if (isFunction(rule.name)) {
    name = rule.name(pit);
  } else if (rule.name) {
    name = rule.name;
  } else {
    name = pit.name;
  }

  name = name.replace(')', '').replace('(', '');

  var textDistance = rule.textDistance ? rule.textDistance : 0;
  query.query.filtered.query.query_string.query = util.format('%s~%d', name, textDistance);

  // console.log(JSON.stringify(query))

  client.search({
    index: config.elasticsearch.index,
    type: 'pit',
    body: query
  }).then(function (res) {
    if (res.hits.hits.length > 0) {
      var hit = res.hits.hits[0];
      var relation = {
        from: pit.id,
        to: hit._source.hgid,
        label: rule.relation
      };

      var result = {
        relation: relation,
        message: util.format('Relation: %s -> %s', pit.name, hit._source.name)
      };

      callback(null, result);
    } else {
      var result = {
        error: pit.id,
        message: util.format('No relation found: %s (id: %s)', pit.name, pit.id)
      };
      callback(null, result);
    }
  }, function (error) {
    callback(error)
  });
}

// TODO: remove async, use highland only
async.eachSeries(sources, function(source, callback) {
  var rules = require('./' + source + '.rules');

  var filename = path.join(config.api.dataDir, 'sources', source, 'current', 'pits.ndjson');

  var relationsStream = fs.createWriteStream(util.format('%s.inferred.ndjson', source), {encoding: 'utf8'});
  var errorsStream = fs.createWriteStream(util.format('%s.inferred.errors.ndjson', source), {encoding: 'utf8'});
  var logStream = fs.createWriteStream(util.format('%s.inferred.log', source), {encoding: 'utf8'});

  var stream = _(fs.createReadStream(filename, {encoding: 'utf8'}))
    .split()
    .compact()
    .map(JSON.parse)
    .map(function(pit) {
      return _(Object.keys(rules)).map(function(ruleSourceid) {
        return _(rules[ruleSourceid])
          .filter(function(rule) {
            // Filter on PIT type for which rule is defined
            return rule.types.from === pit.type || (rule.types.from.constructor === Array
                && rule.types.from.indexOf(pit.type) > -1);
          })
          .filter(function(rule) {
            // Apply the rule's general filter function (if defined)
            if (rule.filter && isFunction(rule.filter)) {
              return rule.filter(pit)
            }
            return true;
          })
          .map(function(rule) {
            // Return PIT, rule and sourceid in one object
            return {
              pit: pit,
              ruleSourceid: ruleSourceid,
              rule: rule
            }
          });
      });
    })
    .flatten()
    .map(function(data) {
      return _.curry(infer, data);
    })
    .nfcall([])
    .parallel(10)

  stream
    .fork()
    .pluck('message')
    .intersperse('\n')
    .pipe(logStream)
    .on('close', function() {
      callback();
    });

  stream
    .fork()
    .pluck('relation')
    .compact()
    .map(JSON.stringify)
    .intersperse('\n')
    .pipe(relationsStream)

  stream
    .fork()
    .pluck('error')
    .compact()
    .intersperse('\n')
    .pipe(errorsStream)

}, function() {
  client.close();
});

