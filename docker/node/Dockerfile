FROM node:11

LABEL description="node"
WORKDIR /usr/src/service

RUN npm install
RUN npx tsc

EXPOSE 3001

CMD /usr/sbin/nginx -g 'daemon off;'