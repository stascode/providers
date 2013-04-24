function createIpMatchMessage(session, user, device) {
    var matchMessage = new nitrogen.Message({ message_type: "ip_match" });
    matchMessage.from = device.id;
    matchMessage.to = user.id;

    matchMessage.save(session, function() {});
}

if (message.message_type == "ip") {
    log.info("deviceMatching agent processing ip message");
    nitrogen.Principal.find(session, { last_ip: message.body.ip_address }, function(err, principalsAtIp) {
        var devices = [];
        var users = [];

        principalsAtIp.forEach(function(principal) {
            if (principal.isUser())
                users.push(principal);
            else if (principal.isDevice())
                devices.push(principal);
        });

        log.info("users length: " + users.length + " devices length: " + devices.length);

        if (users.length != 1) return;  /* don't match devices if more than one (or no) user at this IP address. */

        nitrogen.Principal.find(session, { _id: message.from }, function(err, fromPrincipals) {
            if (err) return log.error("deviceMatch didn't find principal: " + err);

            var fromPrincipal = fromPrincipals[0];

            /* for device 'ip' messages we only generate one ip_match message from the user to that device. */

            if (fromPrincipal.principal_type == "user") {
                /* for each device at this IP address that is not currently owned by a principal, emit an ip_match message. */
                var user = fromPrincipal;
                devices.forEach(function(device) {
                   log.info("creating ip_match message for device: " + device.id);
                   if (!device.owner) createIpMatchMessage(session, user, device);
                });

            } else {
                /* create an ip_match message for this device. */
                var device = fromPrincipal;
                log.info("creating ip_match message for device: " + device.id);
                if (!device.owner) createIpMatchMessage(session, users[0], device);
            }

        });

    });
}