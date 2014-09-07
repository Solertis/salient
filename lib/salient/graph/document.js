
var redis = require("redis");
var Glossary = require("./../glossary/glossary"),
    object = require("./../object"),
    async = require('async'),
    _ = require('underscore')._;

// Default options for the document graph
var defaultOptions = {
    redisPort: 6379,
    redisHost: "localhost",
    redisDb: 0,
    nsPrefix: "",
    separator: ":",
    searchLimit: 100
};

var TOTAL = "t";
var NEXT = "<";
var WEIGHT = "w";
var CONTENT = "^";

// DocumentGraph represents a client for processing documents 
// in order to process document text in order to build a graph of 
// connections between document ids, text, parts of speech context 
// and the language as it is presented through the data.
function DocumentGraph(options) {
    this.options = object.extend(defaultOptions, options || {});
    this._gloss = new Glossary();
    this._redisClient = redis.createClient(this.options.redisPort, this.options.redisHost);
    this._redisClient.select(this.options.redisDb);

    var total = this._fmt(TOTAL) + this.options.separator;
    var next = this._fmt(NEXT) + this.options.separator;
    var content = this._fmt(CONTENT) + this.options.separator;
    var weight = this._fmt(WEIGHT) + this.options.separator;
    this._prefixes = [total,next,content,weight];
};

DocumentGraph.prototype._fmt = function() {
    var args = [];
    if (this.options.nsPrefix.length > 0) {
        args.push(this.options.nsPrefix);
    }
    for (var i in arguments) {
        if (arguments[i] && arguments[i].tag) {
            args.push(arguments[i].tag.toLowerCase());
            args.push(arguments[i].distinct || arguments[i].term.toLowerCase());
        } else if (arguments[i] && arguments[i].length && arguments[i].length > 0) {
            args.push(arguments[i]);
        }
    }
    return args.join(this.options.separator);
};

DocumentGraph.prototype._fmtNode = function (node) {
    var args = [];
    if (node.tag) {
        args.push(node.tag.toLowerCase());
        args.push(node.distinct || node.term.toLowerCase());
    }
    return args.join(this.options.separator);
};

// _incrEdges will increment the total number on the given key, followed by 
// adding/updating the edge weight between the id <-> key. If there is a previous 
// key node present, then we will update/add the edge between the previous key 
// and the newly provided present key, followed by returning the new key.
DocumentGraph.prototype._incrEdges = function (id, key, prevKey) {
    // increment total frequency on the key
    this._redisClient.incrby(this._fmt(TOTAL, key), 1);
    
    // increment/add an edge: id -> key
    // increment/add an edge: id <- key
    this._redisClient.zincrby(this._fmt(id), 1, key);
    this._redisClient.zincrby(this._fmt(key), 1, id);

    // increment/add edge from prevKey -> key (directed edge)
    if (prevKey) {
        this._redisClient.zincrby(this._fmt(NEXT, prevKey), 1, key);
    }

    return key;
};

DocumentGraph.prototype._isPrefixed = function (id) {
    for (var i = 0; i < this._prefixes.length; i++) {
        if (id.indexOf(this._prefixes[i]) == 0) {
            return true;
        }
    }

    return false;
};

// Search will look up the given terms in the graph to find the 
// most relevant documents associated with the given terms using 
// the tfidf scores as a measurement.
DocumentGraph.prototype.search = function (terms, callback, options) {
    var self = this;
    var options = options || {};
    options.searchLimit = options.searchLimit || this.options.searchLimit;
    async.map(terms, function (term, cb) {
        if (term.indexOf(':') < 0) {
            self._redisClient.keys(self._fmt("*", term), function (err, keys) {
                var reducedTerms = [];
                for (var i = 0; i < keys.length; i++) {
                    if (!self._isPrefixed(keys[i])) {
                        reducedTerms.push(keys[i].slice(self.options.nsPrefix.length + 1, keys[i].length));
                    }
                }

                cb(null, reducedTerms);
            });
        } else {
            cb(null, term);
        }
    }, function (err, termResults) {
        terms = _.flatten(termResults);
        async.map(terms, function (term, cb) {
            self._redisClient.zrevrange(self._fmt(WEIGHT, term), 0, options.searchLimit, 'WITHSCORES', cb);
        }, function (err, results) {
            if (err) {
                callback(err);
            }

            var scores = {};
            var ids = [];
            for (var i = 0; i < results.length; i++) {
                var termResults = results[i];
                while (termResults.length) {
                    var docId = termResults.shift();
                    var docTermWeight = parseFloat(termResults.shift(), 10);
                    if (!scores.hasOwnProperty(docId)) {
                        scores[docId] = 0;
                        ids.push(docId);
                    }
                    scores[docId] += docTermWeight;
                }
            }
            ids = ids.sort(function (a, b) { return scores[b] - scores[a] });
            callback(null, [ids,scores]);
        });
    });
};

DocumentGraph.prototype.getContents = function (ids, callback) {
    var formattedIds = [];
    for (var i = 0; i < ids.length; i++)
        formattedIds.push(this._fmt(CONTENT, ids[i]));

    this._redisClient.mget(formattedIds, callback);
};

// readDocument will parse the text, tokenize, and tag it to build a 
// directed and undirected graph of the given document id to various 
// directed nodes that form the structure of the document text. Edge 
// weights are determined by a simple frequency scalar.
DocumentGraph.prototype.readDocument = function (id, text) {
    // increment the total number of documents found
    this._redisClient.incrby(this._fmt(TOTAL), 1);

    // set the content of this document in redis so we can get it later
    this._redisClient.set(this._fmt(CONTENT, id), text);

    // parse the text (tokenize, tag..etc)
    this._gloss.parse(text);
    var current = this._gloss.root;
    var prev = null;
    do {
        var s = current.toJSON();
        if (!s.children && !s.orig && !s.isFiltered) {
            // increment total and add/incr bidirectional edges for current node
            prev = this._incrEdges(id, this._fmtNode(s), prev);
        } else if (!s.isFiltered) {
            if (s.orig && s.children) {
                // increment total and add bidirectional edge weight for original node
                if (!s.orig.isFiltered) {
                    prev = this._incrEdges(id, this._fmtNode(s.orig), prev);
                }

                for (var i = 0; i < s.children.length; i++) {
                    // increment total and add/incr bidirectional edges on child
                    if (!s.children[i].isFiltered) {
                        prev = this._incrEdges(id, this._fmtNode(s.children[i]), prev);
                    }
                }
            }
        }

        current = current.next;
    } while (current);
};

DocumentGraph.prototype._computeTermWeights = function (ids, term, callback) {
    var self = this;
    async.every(ids, function (id, cb) {
        self.TFIDF(id, term, function (err, result) {
            if (err) {
                cb(false);
            } else {
                self._redisClient.zadd(self._fmt(WEIGHT, id), result.tfidf, term, function (err, success) {
                    self._redisClient.zadd(self._fmt(WEIGHT, term), result.tfidf, id, function (err, success) {
                        cb(success);
                    });
                });
            }
        });
    }, callback);
};

// _computeWeights will ensure that all provided terms have their tfidf computed 
// with respect to the given document identifier before returning to callback.
DocumentGraph.prototype._computeWeights = function (id, terms, callback) {
    // compute the tfidf for all terms in this document
    var self = this;
    async.every(terms, function (item, cb) {
        self.TFIDF(id, item, function (err, result) {
            if (err) {
                cb(false);
            } else {
                self._redisClient.zadd(self._fmt(WEIGHT, id), result.tfidf, item, function (err, success) {
                    self._redisClient.zadd(self._fmt(WEIGHT, item), result.tfidf, id, function (err, success) {
                        cb(success);
                    });
                });
            }
        });
    }, callback);
};

// Ensures that all documents in the database are indexed for tfidf weights
DocumentGraph.prototype.indexAllWeights = function (progress, callback) {
    var self = this;
    this._redisClient.keys(this._fmt(CONTENT, "*"), function (err, keys) {
        var iter = 0;
        async.eachLimit(keys, 8, function (item, cb) {
            var id = item.slice((self._fmt(CONTENT) + ":").length, item.length);
            self.indexWeights(id, function (success) {
                iter++;
                progress({ total: keys.length, count: iter, percent: Math.round((iter / keys.length) * 100.0) });
                cb(null);
            });
        }, function () {
            callback({total: keys.length, count: iter});
        });
    });
};

// Ensures that all terms in the given document id are indexed and computed for tfidf
DocumentGraph.prototype.indexWeights = function (id, callback) {
    var self = this;
    this._redisClient.zrange(this._fmt(id), 0, -1, function (err, results) {
        if (!results) {
            callback(false);
            return;
        }

        self._computeWeights(id, results, callback);
    });
};

DocumentGraph.prototype._isIdFiltered = function (filterPrefixes, id) {
    var isFiltered = false;
    if (filterPrefixes && filterPrefixes.length > 0) {
        isFiltered = true;
        for (var i = 0; i < filterPrefixes.length; i++) {
            var prefix = filterPrefixes[i];
            if (id.indexOf(prefix) >= 0) {
                isFiltered = false;
                break;
            }
        }
    }
    return isFiltered;
};

DocumentGraph.prototype._cosineFilter = function (filterPrefixes, id1, id2, callback) {
    var self = this;
    var id1_scores = {};
    var id2_scores = {};
    var ids = [];
    self._redisClient.zrange(self._fmt(WEIGHT, id1), 0, -1, 'WITHSCORES', function (err, id1_results) {
        if (err) {
            callback(err, null);
            return;
        }

        self._redisClient.zrange(self._fmt(WEIGHT, id2), 0, -1, 'WITHSCORES', function (err, id2_results) {
            if (err) {
                callback(err, null);
                return;
            }

            var id1_sum = 0;
            while (id1_results.length) {
                var id = id1_results.shift();
                var score = parseInt(id1_results.shift());
                if (!self._isIdFiltered(filterPrefixes, id)) {
                    id1_scores[id] = score;
                    if (ids.indexOf(id) < 0) {
                        ids.push(id);
                    }

                    id1_sum += (score * score);
                }
            }

            var id2_sum = 0;
            while (id2_results.length) {
                var id = id2_results.shift();
                var score = parseInt(id2_results.shift());
                if (!self._isIdFiltered(filterPrefixes, id)) {
                    id2_scores[id] = score;
                    if (ids.indexOf(id) < 0) {
                        ids.push(id);
                    }

                    id2_sum += (score * score);
                }
            }

            var dotsum = 0;
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                if (id1_scores.hasOwnProperty(id) && id2_scores.hasOwnProperty(id)) {
                    dotsum += (id1_scores[id] * id2_scores[id]);
                }
            }

            var magnitude = (Math.sqrt(id1_sum) * Math.sqrt(id2_sum));
            var sim = dotsum / magnitude;
            callback(null, sim);
            return;
        });
    });
};

// Measures the cosine similarity between two different documents by 
// looking up all the features (concepts only) of a given document id, 
// and for each edge, we will compute them as weighted features.
DocumentGraph.prototype.CosineConceptSimilarity = function (id1, id2, callback) {
    this._cosineFilter(['noun','adj'], id1, id2, callback);
};

// Measures the cosine similarity between two different documents by 
// looking up all the features that represent a given document id, 
// and for each edge, we will compute them as weighted features.
DocumentGraph.prototype.CosineSimilarity = function (id1, id2, callback) {
    this._cosineFilter(null, id1, id2, callback);
};

// TFIDF will return the term frequency - inverse-document frequency of the 
// given arguments. Should the document id be passed in as well, then we will get 
// the tf-idf relative to the given document. Otherwise, we will return the aggregate
// on the given term itself.
DocumentGraph.prototype.TFIDF = function (id, key, callback) {
    // Ensure that we can overload for ('text here', function (err, result)...)
    if (!callback && typeof text == 'function') {
        callback = text;
        text = id;
        id = undefined;
    }

    // Get the total frequency of the given term
    var totalDocKey = this._fmt(TOTAL);
    var totalKey = this._fmt(TOTAL, key);

    // Executes and handles results returned from the multi redis command below
    var execResults = function(err, results) {
        if (err) {
            callback(err);
            return;
        }
        
        var keyFrequency = parseInt(results[0]);
        var docFrequency = parseInt(results[1]);
        var keyDocFrequency = results[2];

        // ensure that key frequency is relative to the given document (when appropriate)
        if (id && results.length == 4) {
            keyFrequency = parseInt(results[3]);
        }
        var tf = 1 + (Math.log(keyFrequency) / Math.LN10);
        var idf = Math.log(docFrequency / keyDocFrequency) / Math.LN10;

        var result = {};
        result.key = key;
        result.rawtf = keyFrequency;
        result.df = keyDocFrequency;
        result.n = docFrequency;
        result.idf = idf;
        result.tf = tf;
        result.tfidf = tf * idf;
        callback(null, result);
    };

    if (id) {
        this._redisClient.multi()
            .get(totalKey).get(totalDocKey).zcard(this._fmt(key)).zscore(this._fmt(id), key)
            .exec(execResults);
    } else {
        this._redisClient.multi()
            .get(totalKey).get(totalDocKey).zcard(this._fmt(key))
            .exec(execResults);
    }
};

module.exports = DocumentGraph;