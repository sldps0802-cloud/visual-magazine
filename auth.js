/* Thin auth wrapper. Every page talks to Auth.*, never to db.auth.* directly -
   so migrating off Supabase later means rewriting this one file, not every page. */
var Auth = {
  login: function(email, password){
    return db.auth.signInWithPassword({ email: email, password: password });
  },
  loginWithGoogle: function(){
    return db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href } });
  },
  logout: function(){
    return db.auth.signOut();
  },
  getSession: function(){
    return db.auth.getSession().then(function(res){ return res.data.session ? res.data.session.user : null; });
  },
  onChange: function(cb){
    return db.auth.onAuthStateChange(function(event, session){ cb(session ? session.user : null); });
  }
};
