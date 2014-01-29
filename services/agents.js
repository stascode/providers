var async = require('async')
  , fs = require('fs')
  , log = require('../log')
  , models = require('../models')
  , nitrogen = require('nitrogen')
  , path = require('path')
  , services = require('../services')
  , utils = require('../utils')
  , vm = require('vm');

var buildServiceClientSession = function(config, callback) {
    if (!services.principals.servicePrincipal) return callback(utils.internalError("Service principal not available."));

    services.accessTokens.findOrCreateToken(services.principals.servicePrincipal, function(err, accessToken) {
        if (err) return callback(err);

        var service = new nitrogen.Service(config);
        var clientPrincipal = new nitrogen.Principal(services.principals.servicePrincipal);
        clientPrincipal.id = accessToken.principal.id;

        var session = new nitrogen.Session(service, clientPrincipal, accessToken);

        return callback(err, session);
    });
};

var create = function(principal, agent, callback) {
    if (!principal) return callback(utils.principalRequired());

    if (!principal.is('service'))
        agent.execute_as = principal.id;

    agent.save(function(err, agent) {
        if (err) return callback(err);

        callback(null, agent);
    });
};

var execute = function(agents, callback) {

    // TODO: this limits us to 1 machine since each instance will load all agents.
    // Break agents out to their own role type and then enable automatically dividing
    // agents between instances of that role.

    async.each(agents, function(agent, callback) {

        if (agent && agent.enabled && agent.session) {
            // TODO: factor this out into some sort of configurable whitelist.
            var context = {
                async: async,
                log: log,
                nitrogen: nitrogen,
                params: agent.params,
                session: agent.session,
                setInterval: setInterval,
                setTimeout: setTimeout
            };

            try {
                agent.compiledAction.runInNewContext(context);
                log.info("Agent " + agent.name + " started.");
            } catch (e) {
                log.error("Agent " + agent.name + " quit after throwing exception: " + e.stack);
            }
        }

        callback();
    }, callback);
};

var filterForPrincipal = function(principal, filter) {
    if (principal && principal.is('service')) return filter;

    // TODO: use permissions based filtering here.  align to a public / visible_to approach?

    filter.$and = [ { execute_as: principal._id } ];

    return filter;
};

var find = function(principal, filter, options, callback) {
    models.Agent.find(filterForPrincipal(principal, filter), null, options, callback);
};

var findById = function(principal, agentId, callback) {
    models.Agent.findOne(filterForPrincipal(principal, { "_id": agentId }), function(err, agent) {
        if (err) return callback(err);
        if (!agent) return callback(utils.notFoundError());
        if (agent.execute_as != principal.id) return callback(utils.authorizationError());

        return callback(null, agent);
    });
};

// TODO: split out everything below into a separate 'reactor' service?
var initialize = function(callback) {
    var agentDir = "./agents/";
    fs.readdir(agentDir, function(err, agentFiles) {
        if (err) return callback("failed to enumerate built in agents: " + err);

        log.info('agents initializing: ' + agentFiles.length + ' built-in agents.');

        // TODO: break out per agent setup into another function.
        async.each(agentFiles, function(file, callback) {
            var agentPath = agentDir + file;

            fs.readFile(agentPath, function (err, action) {
                if (err) return callback(err);

                find(services.principals.servicePrincipal, { name: file, execute_as: services.principals.servicePrincipal.id }, function (err, agents) {
                    if (err) return callback(err);

                    if (agents.length > 0) {
                        log.info("found existing agent for built-in agent: " + file + ": updating with latest action.");

                        update(services.principals.servicePrincipal, agents[0].id, { action: action }, callback);
                    } else {
                        log.info("no existing agent for built-in agent: " + file + ": creating.");
                        var agent = new models.Agent({ action: action,
                                                       enabled: true,
                                                       execute_as: services.principals.servicePrincipal.id,
                                                       name: file });
                        create(services.principals.servicePrincipal, agent, callback);
                    }
                });
            });
        }, callback);
    });
};

var prepareAgents = function(session, agents, callback) {
    async.map(agents, function(agent, callback) {
        if (!agent.enabled) return callback(null, agent);

        agent.compiledAction = vm.createScript(agent.action);

        session.impersonate(agent.execute_as, function(err, impersonatedSession) {
            if (err || !impersonatedSession) {

                log.error("failed to impersonate agent session, skipping agent: " + agent.name + ":" + agent.id);
                return callback(null, null);
            }

            agent.session = impersonatedSession;
            callback(null, agent);
        });
    }, callback);
};

var start = function(config, callback) {
    buildServiceClientSession(config, function(err, session) {
        if (err) return callback(err);

        find(services.principals.servicePrincipal, {}, {}, function (err, agents) {
            if (err) return callback(err);

            prepareAgents(session, agents, function(err, preparedAgents) {
                if (err) return callback(err);

                execute(preparedAgents, function(err) {
                    if (err) log.error("agent execution failed with error: " + err);

                    callback(err);
                });
            });
        });
    });
};

var update = function(principal, id, updates, callback) {
    findById(principal, id, function(err, agent) {
        if (err) return callback(err);
        if (!agent) return callback(utils.notFoundError());
        if (principal.id != agent.execute_as) return callback(util.authorizationError());

        models.Agent.update({ _id: id }, { $set: updates }, function(err, updated) {
            if (err) return callback(err);

            findById(principal, id, callback);
        });
    });
};

module.exports = {
    create: create,
    execute: execute,
    find: find,
    findById: findById,
    initialize: initialize,
    start: start,
    update: update
};
