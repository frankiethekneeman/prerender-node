var request = require('request')
  , url = require('url')
  , querystring = require('querystring')
  , merge = require('merge')
  , zlib = require('zlib');

var prerender = module.exports = function(req, res, next) {
  if(!prerender.shouldShowPrerenderedPage(req)) return next();

  prerender.beforeRenderFn(req, function(err, cachedRender) {

    if (!err && cachedRender) {
      if (typeof cachedRender == 'string') {
        res.status(200);
        return res.send(cachedRender);
      } else if (typeof cachedRender == 'object') {
        res.status(cachedRender.status || 200);
        return res.send(cachedRender.body || '');
      }
    }

    prerender.getPrerenderedPageResponse(req, function(prerenderedResponse) {
        prerender.handleResponse(prerenderedResponse, req, res, next, 1);
    });
  });
};

prerender.handleResponse = function(prerenderedResponse, req, res, next, retries) {
  var shouldRetry = this.retryFn(req, prerenderedResponse);
  if (shouldRetry && this.retryLimit && retries < this.retryLimit) {
    prerender.getPrerenderedPageResponse(req, function(prerenderedResponse) {
        prerender.handleResponse(prerenderedResponse, req, res, next, ++retries);
    });
  } else if (prerenderedResponse) {
    prerenderedResponse.body = prerender.bodyFilterFn(prerenderedResponse.body);
    delete prerenderedResponse.headers['content-length'];  //Delete the declared content length so we don't trip over it.
    prerender.afterRenderFn(req, prerenderedResponse, retries);
    res.set(prerenderedResponse.headers);
    res.status(prerenderedResponse.statusCode)
    return res.send(prerenderedResponse.statusCode, prerenderedResponse.body);
  } else {
    next();
  }
}

// googlebot, yahoo, and bingbot are not in this list because
// we support _escaped_fragment_ and want to ensure people aren't
// penalized for cloaking.
prerender.crawlerUserAgents = [
  // 'googlebot',
  // 'yahoo',
  // 'bingbot',
  'baiduspider',
  'facebookexternalhit',
  'twitterbot',
  'rogerbot',
  'linkedinbot',
  'embedly',
  'quora link preview',
  'showyoubot',
  'outbrain',
  'pinterest',
  'developers.google.com/+/web/snippet',
  'slackbot',
  'vkShare',
  'W3C_Validator'
];


prerender.extensionsToIgnore = [
  '.js',
  '.css',
  '.xml',
  '.less',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.doc',
  '.txt',
  '.ico',
  '.rss',
  '.zip',
  '.mp3',
  '.rar',
  '.exe',
  '.wmv',
  '.doc',
  '.avi',
  '.ppt',
  '.mpg',
  '.mpeg',
  '.tif',
  '.wav',
  '.mov',
  '.psd',
  '.ai',
  '.xls',
  '.mp4',
  '.m4a',
  '.swf',
  '.dat',
  '.dmg',
  '.iso',
  '.flv',
  '.m4v',
  '.torrent'
];


prerender.whitelisted = function(whitelist) {
  prerender.whitelist = typeof whitelist === 'string' ? [whitelist] : whitelist;
  return this;
};


prerender.blacklisted = function(blacklist) {
  prerender.blacklist = typeof blacklist === 'string' ? [blacklist] : blacklist;
  return this;
};


prerender.shouldShowPrerenderedPage = function(req) {
  var userAgent = req.headers['user-agent']
    , bufferAgent = req.headers['x-bufferbot']
    , isRequestingPrerenderedPage = false;

  if(!userAgent) return false;
  if(req.method != 'GET' && req.method != 'HEAD') return false;

  //if it contains _escaped_fragment_, show prerendered page
  var parsedQuery = url.parse(req.url, true).query;
  if(parsedQuery && parsedQuery.hasOwnProperty('_escaped_fragment_')) isRequestingPrerenderedPage = true;

  //if it is a bot...show prerendered page
  if(prerender.crawlerUserAgents.some(function(crawlerUserAgent){ return userAgent.toLowerCase().indexOf(crawlerUserAgent.toLowerCase()) !== -1;})) isRequestingPrerenderedPage = true;

  //if it is BufferBot...show prerendered page
  if(bufferAgent) isRequestingPrerenderedPage = true;

  //if it is a bot and is requesting a resource...dont prerender
  if(prerender.extensionsToIgnore.some(function(extension){return req.url.indexOf(extension) !== -1;})) return false;

  //if it is a bot and not requesting a resource and is not whitelisted...dont prerender
  if(Array.isArray(this.whitelist) && this.whitelist.every(function(whitelisted){return (new RegExp(whitelisted)).test(req.url) === false;})) return false;

  //if it is a bot and not requesting a resource and is not blacklisted(url or referer)...dont prerender
  if(Array.isArray(this.blacklist) && this.blacklist.some(function(blacklisted){
    var blacklistedUrl = false
      , blacklistedReferer = false
      , regex = new RegExp(blacklisted);

    blacklistedUrl = regex.test(req.url) === true;
    if(req.headers['referer']) blacklistedReferer = regex.test(req.headers['referer']) === true;

    return blacklistedUrl || blacklistedReferer;
  })) return false;

  return isRequestingPrerenderedPage;
};


prerender.getPrerenderedPageResponse = function(req, callback) {
  var options = {
    uri: url.parse(prerender.buildApiUrl(req)),
    followRedirect: false
  };
  options.headers = {
    'User-Agent': req.headers['user-agent'],
    'Accept-Encoding': 'gzip'
  };
  if(this.prerenderToken || process.env.PRERENDER_TOKEN) {
    options.headers['X-Prerender-Token'] = this.prerenderToken || process.env.PRERENDER_TOKEN;
  }
  if (typeof this.requestOptions == 'object') {
    options = merge.recursive(true, options, this.requestOptions);
  }

  request.get(options).on('response', function(response) {
    if(response.headers['content-encoding'] && response.headers['content-encoding'] === 'gzip') {
      prerender.gunzipResponse(response, callback);
    } else {
      prerender.plainResponse(response, callback);
    }
  }).on('error', function() {
    callback(null);
  });
};

prerender.gunzipResponse = function(response, callback) {
  var gunzip = zlib.createGunzip()
    , content = '';

  gunzip.on('data', function(chunk) {
    content += chunk;
  });
  gunzip.on('end', function() {
    response.body = content;
    delete response.headers['content-encoding'];
    delete response.headers['content-length'];
    callback(response);
  });

  response.pipe(gunzip);
};

prerender.plainResponse = function(response, callback) {
  var content = '';

  response.on('data', function(chunk) {
    content += chunk;
  });
  response.on('end', function() {
    response.body = content;
    callback(response);
  });
};


prerender.buildApiUrl = function(req) {
  var prerenderUrl = prerender.getPrerenderServiceUrl();
  var forwardSlash = prerenderUrl.indexOf('/', prerenderUrl.length - 1) !== -1 ? '' : '/';

  var protocol = req.protocol;
  if (req.get('CF-Visitor')) {
    var match = req.get('CF-Visitor').match(/"scheme":"(http|https)"/);
    if (match) protocol = match[1];
  }
  if (req.get('X-Forwarded-Proto')) {
    protocol = req.get('X-Forwarded-Proto').split(',')[0];
  }
  if (this.protocol) {
    protocol = this.protocol;
  }

  var fullUrl = protocol + "://" + (this.host || req.get('host')) + url.parse(req.url, true).pathname;
  var qs = {};
  if (req.query) {
    Object.keys(req.query).forEach(function(key) {
        if (key != '_escaped_fragment_') {
            qs[key] = req.query[key];
        }
    });
  }

  if (Object.keys(qs).length) {
    fullUrl += '?' + querystring.stringify(qs);
  }

  return prerenderUrl + forwardSlash + fullUrl;
};


prerender.getPrerenderServiceUrl = function() {
  return this.prerenderServiceUrl || process.env.PRERENDER_SERVICE_URL || 'http://service.prerender.io/';
};

prerender.beforeRenderFn = function(req, done) {
  if (!this.beforeRender) return done();

  return this.beforeRender(req, done);
};

prerender.retryFn = function(req, prerender_res) {
  if (!this.retry) return false;

  return this.retry(req, prerender_res);
};

prerender.afterRenderFn = function(req, prerender_res, retries) {
  if (!this.afterRender) return;

  this.afterRender(req, prerender_res, retries);
};

prerender.bodyFilterFn = function(body) {
    if (!this.bodyFilter) return body;
    else return this.bodyFilter(body);
}

prerender.set = function(name, value) {
  this[name] = value;
  return this;
};
