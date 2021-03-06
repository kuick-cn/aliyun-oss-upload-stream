'use strict';

var Writable = require('stream').Writable;
var events = require('events');

function Client(client) {
  if (!client) throw new Error('Must configure an oss client before attempting to create an oss upload stream.');

  // 安全监测
  if (!(this instanceof Client)) {
    return new Client(client);
  }

  this.cachedClient = client;
}

Client.prototype.upload = function (destinationDetails) {

  if (!arguments.length || Object.prototype.toString.call(destinationDetails) !== '[object Object]') throw new Error('Parameter is not correct');

  var e = new events.EventEmitter();
  var cachedClient = this.cachedClient;
  var multipartUploadID = null;
  var multipartUploadResult = null;

  // 缓存的buffer数据
  var receivedBuffers = [];

  // 缓存的buffer数据长度
  var receivedBuffersLength = 0;

  // Part 列表，用于数据全部上传成功后，验证Part有效性
  var partIds = [];

  // Part 索引
  var localPartNumber = 0;

  // 用于判断是否 Parts 全部上传完毕（服务器端->阿里云）
  var pendingParts = 0;
  // 判断是否上传完毕（客户端->服务器端）
  var completed = false;

  var ws = new Writable({
    highWaterMark: 4194304 // 4 MB
  });

  ws._write = function (chunk, encoding, next) {
    // 缓存buffer
    absorbBuffer(chunk);

    if (multipartUploadID) {
      checkAndflushPart();
    }

    // 上传数据前，必须先初始化
    if (!multipartUploadID && !e.listeners('ready').length) {
      // 注册ready事件
      e.once('ready', checkAndflushPart);

      // 初始化MultipartUpload
      createMultipartUpload(destinationDetails);
    }

    next();
  };

  ws.end = function () {
    completed = true;

    if (multipartUploadID) {
      checkAndflushPart();
    }
  };

  /*
   * 初始化 Multipart Upload
   * 使用 Multipart Upload 模式传输数据前,必须先调用该接口来通知 OSS 初始 化一个 Multipart Upload 事件
   *
   * 初始化结束后，触发ready事件
   * @param {Object} Bucket && Key
   */
  function createMultipartUpload(details) {
    cachedClient.createMultipartUpload(details, function (err, data) {
      if (err) return abortUpload(err);
      multipartUploadID = data.UploadId;
      multipartUploadResult = data;
      e.emit('ready');
    });
  }

  /*
   * 检查flushPart的大小是否大于100KB
   * 
   */
  var checkAndflushPart = function () {
     if (receivedBuffersLength > 1024 * 100 || completed) {
        flushPart();
     }
  };

  /*
   * 分块(Part)上传数据
   */
  var flushPart = function () {
    var chunk = preparePartBuffer();
    localPartNumber++;
    pendingParts++;

    (function (localPartNumber) {
      cachedClient.uploadPart({
        Body: chunk,
        Bucket: multipartUploadResult.Bucket,
        Key: multipartUploadResult.Key,
        UploadId: multipartUploadID,
        PartNumber: localPartNumber
      }, function (err, result) {
        if (err) return abortUpload(err);

        pendingParts--;

        var part = {
          ETag: result.ETag,
          PartNumber: localPartNumber
        };

        partIds[localPartNumber - 1] = part;

        ws.emit('part', part);

        if (!pendingParts && completed) completeUpload();
      });
    })(localPartNumber);
  };

  /*
   * 上传成功
   *
   * 在将所有数据 Part 都上传完成后,必须调用 Complete Multipart Upload API 来完成整个文件的 Multipart Upload。在执行该操作时,用户必须 供所有有效 的数据 Part 的列表(包括 part 号码和 ETAG);OSS 收到用户 交的 Part 列表后, 会逐一验证每个数据 Part 的有效性。当所有的数据 Part 验证通过后,OSS 将把 这些数据 part 组合成一个完整的 Object。
   *
   * @return {Object} ossObject
   */
  var completeUpload = function () {
    cachedClient.completeMultipartUpload({
      Bucket: multipartUploadResult.Bucket,
      Key: multipartUploadResult.Key,
      UploadId: multipartUploadID,
      CompleteMultipartUpload: {
        Parts: partIds
      }
    }, function (err, result) {
      if (err) return abortUpload(err);
      ws.emit('uploaded', result);
    });
  };

  /*
   * 缓存Buffer
   */
  function absorbBuffer(incomingBuffer) {
    receivedBuffers.push(incomingBuffer);
    receivedBuffersLength += incomingBuffer.length;
  }

  /*
   * 生成 chunk
   * 根据缓存的buffer数据，生成一个新buffer并返回
   *
   * @return {Buffer} chunk
   */
  function preparePartBuffer() {
    var combinedBuffer = Buffer.concat(receivedBuffers, receivedBuffersLength);
    receivedBuffers = [];
    receivedBuffersLength = 0;

    return combinedBuffer;
  }

  /*
   * 终止Multipart Upload 事件
   *
   * 当一个Multipart Upload事件被中止后，就不能再使用这个Upload ID做任何操作，已经上传的 Part 数据也会被删除
   *
   * @param {error} 错误信息
   */
  function abortUpload(rootError) {
    cachedClient.abortMultipartUpload({
      Bucket: multipartUploadResult.Bucket,
      Key: multipartUploadResult.Key,
      UploadId: multipartUploadID
    }, function (err) {
      if (err) {
        ws.emit('error', rootError + '\n Additionally failed to abort the multipart upload on OSS: ' + err);
      } else {
        ws.emit('error', rootError);
      }
    });
  }

  return ws;
};

module.exports = Client;