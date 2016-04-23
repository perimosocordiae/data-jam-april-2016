var fs = require('fs');

var _ = require('lodash');
var request = require('request');
var csv = require('csv-stream');
var JSONStream = require('JSONStream');
var streamToPromise = require('stream-to-promise');


var SOURCE_DATA_PATH = './311-Public-Data-Extract-2015-tab.txt';
var SOURCE_DATA_SWM_PATH = './311-Public-Data-Extract-2015-swm-tab.txt';

var NEIGHBORHOODS_COPY_PATH = './neighborhoods/boundaries.geojson';
var NEIGHBORHOODS_ALIASES_PATH = './neighborhoods/boundaries-with-aliases.geojson';

var API_ENDPOINT_FOR_GEOJSON = 'https://api.everyblock.com/gis/houston/neighborhoods/?token=90fe24d329973b71272faf3f5d17a8602bff996b';

/**
 * Main
 */

// Checks whether local copy of geojson already exists
fs.access(NEIGHBORHOODS_COPY_PATH, fs.R_OK | fs.W_OK, function(err) {
  if(err) {
    // If local copy does not exist, get them from the api before assigning the aliases
    getNeighborhoodGeojson(API_ENDPOINT_FOR_GEOJSON, NEIGHBORHOODS_COPY_PATH)
      .then(getNeighborhoodNames)
      .then(_.partial(setNeighborhoodAliases, SOURCE_DATA_PATH))
      .then(_.partial(setNeighborhoodAliases, SOURCE_DATA_SWM_PATH))
      .then(_.partial(writeAliases, NEIGHBORHOODS_ALIASES_PATH));
  } else {
    // Otherwise, go ahead and just assign aliases.
    getNeighborhoodNames({localPath: NEIGHBORHOODS_COPY_PATH})
      .then(_.partial(setNeighborhoodAliases, SOURCE_DATA_PATH))
      .then(_.partial(setNeighborhoodAliases, SOURCE_DATA_SWM_PATH))
      .then(_.partial(writeAliases, NEIGHBORHOODS_ALIASES_PATH));
  }
});


/**
 * Workflow functions
 */


function getNeighborhoodGeojson(apiEndpoint, localPath){
  var writeNeighborhoods = fs.createWriteStream(localPath);
  var writePromise = streamToPromise(writeNeighborhoods);

  // Grab data from api, parse out JSON from the "data" key,
  // and write the result data to our local geojson file.
  request(apiEndpoint)
    .pipe(JSONStream.parse('data'))
    .pipe(JSONStream.stringify(false))
    .pipe(writeNeighborhoods);

  // Return a promise so that when the write is done,
  // we can continue with other steps.
  // 
  // Pass on the localPath as well for next steps to use.
  return writePromise.then(function(){
    console.log(`Copied geojson from API at ${API_ENDPOINTS_FOR_NEIGHBORHOODS}`);
    return {
      localPath: localPath
    };
  });
}


function getNeighborhoodNames(context){
  var readNeighborhoods = fs.createReadStream(context.localPath);
  var readPromise = streamToPromise(readNeighborhoods)

  var neighborhoods = [];

  // Read from the local geojson, and get the "name" of each feature.
  // Push each of the names to a `neighborhoods` array.
  readNeighborhoods
    .pipe(JSONStream.parse('features.*.properties.name'))
    .on('data', function(data){
      neighborhoods.push({name: data});
    });

  // Pass the `neighborhoods` array out through the promise so that
  // when the file has been parsed through for names, the array can be used.
  return readPromise.then(function(){
    console.log('Grabbed neighborhoods names.');
    context.neighborhoods = neighborhoods;
    return context;
  });
}

function setNeighborhoodAliases(sourceDataPath, context){
  var neighborhoods = context.neighborhoods;

  var sourceDataSteam = fs.createReadStream(sourceDataPath);
  var setPromise = streamToPromise(sourceDataSteam);

  var csvStreamOptions = { delimiter : '\t', endLine : '\n', escapeChar : '"', enclosedChar : '"'};
  var csvStream = csv.createStream(csvStreamOptions);

  // "clean" neighborhood names for matching with aliases later.
  var namesReference = _.map(neighborhoods, function(neighborhood){
    return cleanNeighborhoodName(neighborhood.name);
  });

  // missing matches array
  var missing = [];

  // Read the source data, and for each `NEIGHBORHOOD`, check for a matching
  // name on the main `neighborhoods` array.  If a value from the source data
  // and a name in the `neighborhoods` array matches, set the alias in the
  // `neighborhoods` array.
  sourceDataSteam.pipe(csvStream)
    .on('column', function(key, value){
      if(key === 'NEIGHBORHOOD' && !(_.isEmpty(value) || value === 'NA')){
        var matcher = cleanNeighborhoodName(value);

        // If "cleaned" value from source file is found in "clean" neighborhood names array,
        // set the alias.
        var matchingNeighborhoodIndex = namesReference.indexOf(matcher);
        if(matchingNeighborhoodIndex > -1 && !hasAlias(neighborhoods[matchingNeighborhoodIndex])){
          neighborhoods[matchingNeighborhoodIndex].alias = value;

          // Stop reading the source file early if we finish assigning aliases.
          if(!_.find(neighborhoods, _.negate(hasAlias))){
            sourceDataSteam.destroy();
          }
        }

        if(matchingNeighborhoodIndex === -1){
          missing.push(value);
        }

      }
    });


  // Pass the `neighborhoods` array out through the promise so that
  // when all aliases have been set, the array can be used.
  return setPromise.then(function(){
    // Log out the missing values for source file.
    var missingValues = _.uniq(missing).join(', ');
    console.log(`Values of ${missingValues} from ${sourceDataPath} missing match.`);

    console.log(`Set neighborhoods aliases from ${sourceDataPath}.`);
    return context;
  });
}

function writeAliases(finalPath, context){
  var neighborhoods = context.neighborhoods;

  var readNeighborhoods = fs.createReadStream(context.localPath);
  var writeNeighborhoodAliases = fs.createWriteStream(finalPath);

  var writePromise = streamToPromise(writeNeighborhoodAliases);

  // Read the current local geojson and modify the `properties` of each feature
  // to include the `alias`.  Write the data with the aliases to a new file.
  readNeighborhoods
    .pipe(JSONStream.parse())
    .on('data', function(data){
      _.forEach(data.features, function(feature) {
        var alias = _.find(neighborhoods, {name: feature.properties.name}).alias;
        feature.properties.alias = alias;
      });
    })
    .pipe(JSONStream.stringify(false))
    .pipe(writeNeighborhoodAliases)


  // Return a promise so that when the write is done,
  // we can continue with other steps if needed.
  return writePromise.then(function(writeBuffer){
    console.log(`Aliases written to ${finalPath}!`);
    context.finalPath = finalPath;
    return context;
  });
}


/**
 * Neighborhood name utility functions
 */

function hasAlias(neighborhood){
  return neighborhood.alias;
}

function cleanNeighborhoodName(neighborhood){
  // Some neighborhoods are annoyingly named/mis-matched. :(
  var weirdClean = neighborhood.replace(/(Memorial Park)$/g, 'Memorial P').replace(/(BRAESWOOD PLACE)/g, 'BRAESWOOD');
  var regularClean = weirdClean.toUpperCase().replace(/-|\/| /g, '');
  return regularClean;
}