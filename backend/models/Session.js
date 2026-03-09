import mongoose from 'mongoose';
const S = new mongoose.Schema({
  sessionId:    { type:String, required:true, unique:true },
  businessId:   { type:String, required:true },
  businessName: { type:String },
  timestamp:    { type:Date, default:Date.now },
  status:       { type:String, enum:['PENDING','PASSED','FLAGGED','REVIEW'], default:'PENDING' },
  trustScore:   { type:Number, default:null },
  geoScore:     { type:Number, default:null },
  s3VideoUri:   { type:String },
  s3ThumbUri:   { type:String },
  aiResults: { textDetected:String, labels:[String], infraScore:Number, isFlagged:Boolean },
  meta: {
    device:String, isRooted:Boolean,
    gpsStart:{ lat:Number, lng:Number },
    gpsEnd:  { lat:Number, lng:Number },
    accelerometer: [{ x:Number, y:Number, z:Number, t:Number }]
  }
});
export default mongoose.model('Session', S);
