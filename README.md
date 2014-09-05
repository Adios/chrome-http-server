chrome-http-server
====
Implements an HTTP server on Google Chrome, bases on the

* chrome.sockets.tcp
* chrome.sockets.tcpServer

provided in the chrome's packaged app API.

Usage
----

include `event.js`, `http.js` in your `main.html` (or packaged app entry point).

as a transparent proxy, with the help of `proxy.pac`:

    var prpr = http.server();
    prpr.onRequest.addListener(prprOnRequest);
    prpr.listen(1227);

or as a plain HTTP server function:

    http.server(onServe).listen(1989);

Example
----
* load this app into Chrome browser (beta, dev+)
* activate it from the extension panel.  

`server.js` provides a example usage of this library.

It listens on port 1989 with a simple HTTP server function, and listens on port 1227 to be a transparent proxy.

use `proxy.pac` to intercept the requests into the established transparent proxy.
