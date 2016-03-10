/* eslint-env browser */

var constants = require('./lib/constants.js');

var swScript = document.currentScript.dataset.serviceWorker;
var manifestAttribute = document.documentElement.getAttribute('manifest');

if (manifestAttribute && 'serviceWorker' in navigator) {
  var manifestUrl = (new URL(manifestAttribute, location.href)).href;

  openIdb().then(function(db) {
    return checkManifestVersion(db, manifestUrl).then(function(hash) {
      return updateManifestAssociationForCurrentPage(db, manifestUrl, hash);
    });
  }).then(function() {
    if (swScript) {
      return navigator.serviceWorker.register(swScript);
    }
  });
}

/**
 * Opens a connection to IndexedDB, using the idb library.
 *
 * @returns {Promise.<DB>}
 */
function openIdb() {
  var idb = require('idb');
  return idb.open(constants.DB_NAME, constants.DB_VERSION, function(upgradeDB) {
    if (upgradeDB.oldVersion === 0) {
      Object.keys(constants.OBJECT_STORES).forEach(function(objectStore) {
        upgradeDB.createObjectStore(constants.OBJECT_STORES[objectStore]);
      });
    }
  })
}

/**
 * Caches the Responses for one or more URLs, using the Cache Storage API.
 *
 * @param {String} hash
 * @param {Array.<String>} urls
 * @returns {Promise.<T>}
 */
function addToCache(hash, urls) {
  // Use the manifest hash as the name of the Cache to open.
  return caches.open(hash).then(function(cache) {
    var fetchRequests = urls.map(function(url) {
      // See Item 18.3 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
      var request = new Request(url, {
        credentials: 'include',
        headers: {
          'X-Use-Fetch': true
        },
        redirect: 'manual'
      });

      return fetch(request).then(function(response) {
        var cacheControl = response.headers.get('Cache-Control');
        if (cacheControl && cacheControl.indexOf('no-store') !== -1) {
          // Bail early if we're told not to cache this response.
          return;
        }

        if (response.ok) {
          return cache.put(url, response);
        }

        // See Item 18.5 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
        if (response.status !== 404 &&
            response.status !== 410) {
          // Assuming this isn't a 200, 404 or 410, we want the .catch() to
          // trigger, which will cause any previously cached Response for this
          // URL to be copied over to this new cache.
          return Promise.reject();
        }
      }).catch(function(error) {
        // We're here if one of the following happens:
        // - The fetch() rejected due to a NetworkError.
        // - The HTTP status code from the fetch() was something other than
        //   200, 404, and 410 AND the response isn't Cache-Control: no-store
        return caches.match(url).then(function(response) {
          // Add a copy of the cached response to this new cache, if it exists.
          if (response) {
            return cache.put(url, response.clone());
          }
        });
      });
    });

    return Promise.all(fetchRequests);
  });
}

/**
 * Compares the copy of a manifest obtained from fetch() with the copy stored
 * in IndexedDB. If they differ, it kicks off the manifest update process.
 *
 * It returns a Promise which fulfills with the hash for the current manifest.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @returns {Promise.<String>}
 */
function checkManifestVersion(db, manifestUrl) {
  var tx = db.transaction(constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);
  var store = tx.objectStore(
    constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

  // See Item 4 of https://html.spec.whatwg.org/multipage/browsers.html#downloading-or-updating-an-application-cache
  var manifestRequest = new Request(manifestUrl, {
    credentials: 'include',
    headers: {
      'X-Use-Fetch': true
    }
  });

  return Promise.all([
    // TODO: Handle manifest fetch failure errors.
    // TODO: Consider cache-busting if the manifest response > 24 hours old.
    fetch(manifestRequest).then(function(manifestResponse) {
      return manifestResponse.text();
    }).then(function(text) {
      var md5 = require('blueimp-md5');
      return {
        // Hash a combination of URL and text so that two identical manifests
        // served from a different location are treated distinctly.
        hash: md5(manifestUrl + text),
        text: text
      };
    }),
    store.get(manifestUrl)
  ]).then(function(values) {
    // values[0].hash is the MD5 hash of the manifest returned by fetch().
    // values[0].text is the manifest text returned by fetch().
    // values[1] is array of Objects with {hash, parsed} properties, or null.
    var knownManifests = values[1] || [];
    var knownManifestVersion = knownManifests.some(function(entry) {
      return entry.hash === values[0].hash;
    });

    if (knownManifestVersion) {
      // If we already know about this manifest version, return the hash.
      return values[0].hash;
    } else {
      // If the hash of the manifest retrieved from the network isn't already
      // in the list of known manifest hashes, then trigger an update.
      return performManifestUpdate(db, manifestUrl, values[0].hash,
        values[0].text, knownManifests);
    }
  });
}

/**
 * Parses the newest manifest text into the format described at
 * https://www.npmjs.com/package/parse-appcache-manifest
 * The parsed manifest is stored in IndexedDB.
 * This also calls addToCache() to cache the relevant URLs from the manifest.
 *
 * It returns a Promise which fulfills with the hash for the current manifest.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @param {String} hash
 * @param {String} text
 * @param {Array.<Object>} knownManifests
 * @returns {Promise.<String>}
 */
function performManifestUpdate(db, manifestUrl, hash, text, knownManifests) {
  var parseAppCacheManifest = require('parse-appcache-manifest');
  var parsedManifest = makeManifestUrlsAbsolute(manifestUrl,
    parseAppCacheManifest(text));

  var tx = db.transaction(constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS,
    'readwrite');
  var store = tx.objectStore(
    constants.OBJECT_STORES.MANIFEST_URL_TO_CONTENTS);

  knownManifests.push({
    hash: hash,
    parsed: parsedManifest
  });

  var fallbackUrls = Object.keys(parsedManifest.fallback).map(function(key) {
    return parsedManifest.fallback[key];
  });

  return Promise.all([
    store.put(knownManifests, manifestUrl),
    // Wait on tx.complete to ensure that the transaction succeeded.
    tx.complete,
    addToCache(hash, parsedManifest.cache.concat(fallbackUrls))
  ]).then(function() {
    return hash;
  });
}

/**
 * Updates IndexedDB to indicate that the current page's URL is associated
 * with the AppCache manifest at manifestUrl, versioned with the hash.
 * It also adds the current page to the cache, matching the implicit
 * cache-as-you-go behavior you get with AppCache.
 *
 * @param {DB} db
 * @param {String} manifestUrl
 * @param {String} hash
 * @returns {Promise.<T>}
 */
function updateManifestAssociationForCurrentPage(db, manifestUrl, hash) {
  var tx = db.transaction(constants.OBJECT_STORES.PATH_TO_MANIFEST,
    'readwrite');
  var store = tx.objectStore(constants.OBJECT_STORES.PATH_TO_MANIFEST);

  return Promise.all([
    store.put({
      url: manifestUrl,
      hash: hash
    }, location.href),
    // Wait on tx.complete to ensure that the transaction succeeded.
    tx.complete,
    addToCache(hash, [location.href])
  ]);
}

/**
 * Converts all the URLs in a given manifest's CACHE, NETWORK, and FALLBACK
 * sections to be absolute URLs.
 *
 * @param {String} baseUrl
 * @param {Object} originalManifest
 * @returns {Object}
 */
function makeManifestUrlsAbsolute(baseUrl, originalManifest) {
  var manifest = {};

  manifest.cache = originalManifest.cache.map(function(relativeUrl) {
    return (new URL(relativeUrl, baseUrl)).href;
  });

  manifest.network = originalManifest.network.map(function(relativeUrl) {
    if (relativeUrl === '*') {
      return relativeUrl;
    }

    return (new URL(relativeUrl, baseUrl)).href;
  });

  manifest.fallback = {};
  Object.keys(originalManifest.fallback).forEach(function(key) {
    manifest.fallback[(new URL(key, baseUrl)).href] =
      (new URL(originalManifest.fallback[key], baseUrl)).href;
  });

  return manifest;
}
